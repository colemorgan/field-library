#!/usr/bin/env python3
"""Build a deterministic EPUB 2 from pinned CDC text snapshots. Python stdlib only."""
import argparse
from datetime import datetime, timezone
import hashlib
from html import escape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urljoin, urlsplit, urldefrag
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED, ZIP_STORED

ROOT = Path(__file__).resolve().parent
VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
ALLOWED = {'div','p','h2','h3','h4','ul','ol','li','strong','em','b','i','sup','sub','table','thead','tbody','tr','th','td','blockquote','br','hr','span','a'}

def sha(data):
    return hashlib.sha256(data).hexdigest()

class Node:
    def __init__(self, tag, attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []
    def text(self):
        return ''.join(c if isinstance(c,str) else c.text() for c in self.children)
    def walk(self):
        yield self
        for c in self.children:
            if isinstance(c, Node):
                yield from c.walk()

class DOM(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node('root')
        self.stack = [self.root]
        self.feed(html)
    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs)
        self.stack[-1].children.append(n)
        if tag not in VOID:
            self.stack.append(n)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break
    def handle_data(self, data):
        self.stack[-1].children.append(data)

def normalized_url(url):
    return urldefrag(url)[0].removesuffix('index.html').rstrip('/')

def extract(raw, source, sources):
    dom = DOM(raw.decode('utf-8'))
    regions = [n for n in dom.root.walk() if set(n.attrs.get('class','').split()) & {'cdc-dfe-body__top','cdc-dfe-body__center'}]
    if len(regions) != 2:
        raise ValueError(f"{source['id']}: expected exactly two CDC content regions, got {len(regions)}")
    dates = [n.attrs['content'] for n in dom.root.walk() if n.tag=='meta' and n.attrs.get('property')=='article:published_time' and n.attrs.get('content')]
    links, omitted = [], []
    known = {normalized_url(s['url']): s['id']+'.xhtml' for s in sources}
    ids = {n.attrs['id'] for r in regions for n in r.walk() if n.attrs.get('id')}
    def render(n):
        if isinstance(n,str):
            return escape(n)
        if n.tag in {'script','style','button','iframe','video','audio','svg','form'}:
            omitted.append(n.tag)
            return ''
        if n.tag == 'img':
            omitted.append(n.attrs.get('src','image'))
            # Photos may have third-party rights. Keep captions, omit image bytes.
            return ''
        body = ''.join(render(c) for c in n.children)
        tag = n.tag if n.tag in ALLOWED else 'div'
        if n.tag == 'figcaption':
            tag = 'p'
        attrs = ''
        if n.attrs.get('id'):
            attrs += ' id="'+escape(n.attrs['id'],quote=True)+'"'
        for a in ('colspan','rowspan'):
            if tag in {'td','th'} and n.attrs.get(a,'').isdigit():
                attrs += f' {a}="{n.attrs[a]}"'
        if tag == 'a' and n.attrs.get('href'):
            absolute = urljoin(source['url'],n.attrs['href'])
            base, fragment = urldefrag(absolute)
            if normalized_url(base) == normalized_url(source['url']) and fragment in ids:
                href = '#'+fragment
            elif normalized_url(base) in known:
                # Cross-page links go to the chapter start; no guessed fragment IDs.
                href = known[normalized_url(base)]
            elif urlsplit(absolute).scheme in {'http','https'}:
                href = absolute
                if absolute not in links:
                    links.append(absolute)
                body += ' [online]'
            else:
                return body
            attrs += ' href="'+escape(href,quote=True)+'"'
        if tag in {'br','hr'}:
            return f'<{tag}{attrs} />'
        return f'<{tag}{attrs}>{body}</{tag}>'
    body = ''.join(render(r) for r in regions)
    if len(''.join(r.text() for r in regions).strip()) < 500:
        raise ValueError(f"{source['id']}: suspiciously short content")
    return body, {'external_links':links, 'omitted_media':omitted, 'source_published':dates[0] if dates else None}

def page(title, body):
    return '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>'+escape(title)+'</title><link rel="stylesheet" type="text/css" href="style.css" /></head><body>'+body+'</body></html>'

def fetch(sources, refresh=False):
    cache = ROOT/'cache'
    cache.mkdir(exist_ok=True)
    records = []
    lock = ROOT/'sources.lock.json'
    old = {r['id']:r for r in json.loads(lock.read_text())} if lock.exists() and not refresh else {}
    for s in sources:
        req = Request(s['url'])
        with urlopen(req,timeout=30) as response:
            if urlsplit(response.url).hostname != 'www.cdc.gov':
                raise ValueError('Unexpected redirect outside www.cdc.gov')
            raw = response.read(5_000_001)
        if len(raw)>5_000_000:
            raise ValueError('Source exceeds 5 MB')
        _, audit = extract(raw,s,sources)
        digest = sha(raw)
        (cache/(digest+'.html')).write_bytes(raw)
        if s['id'] in old:
            previous = old[s['id']]
            if any(previous.get(k)!=v for k,v in s.items()) or previous['sha256']!=digest:
                raise ValueError('Pinned source changed: '+s['id']+'. Review changes, then use fetch --refresh.')
            records.append(previous)
        else:
            records.append({**s,'sha256':digest,'retrieved_at':datetime.now(timezone.utc).isoformat(),**audit})
        print('Fetched',s['id'])
    # Replace lock only after every source was successfully downloaded and parsed.
    (ROOT/'sources.lock.json').write_text(json.dumps(records,indent=2)+'\n')

def build(sources):
    records = json.loads((ROOT/'sources.lock.json').read_text())
    if [{k:r[k] for k in s} for s,r in zip(sources,records)] != sources or len(records)!=len(sources):
        raise ValueError('Manifest changed: run fetch explicitly to update the lock')
    uid = 'urn:sha256:'+sha(json.dumps(records,sort_keys=True).encode())
    intro = '<h1>Field Library</h1><p>Personal offline reference — starter edition.</p><p>Four CDC text chapters. This is not a complete survival manual. First aid, shelter, repairs and regional maps are not included yet.</p><p>Source wording and captions are retained; photographs, video, scripts and site navigation are omitted. Links marked [online] require internet and are not included. Follow the table of contents to navigate offline.</p><p>Converted text has not been professionally reviewed or validated on the target e-reader. Compare instructions with their originals before relying on this conversion.</p>'
    intro += '<h2>Contents</h2><ul>'+''.join(f'<li><a href="{s["id"]}.xhtml">{escape(s["category"]+": "+s["title"])}</a></li>' for s in sources)+'</ul>'
    intro += '<h2>Credits</h2><p>Sources: U.S. Centers for Disease Control and Prevention. No agency endorsement. Original project code is MIT-licensed; source content retains its own status. No CDC logos or third-party photographs are redistributed.</p>'
    chapters = [('start','Start here',page('Field Library',intro))]
    audit = []
    for r in records:
        raw = (ROOT/'cache'/(r['sha256']+'.html')).read_bytes()
        if sha(raw)!=r['sha256']:
            raise ValueError('Source hash mismatch: '+r['id'])
        body, details = extract(raw,r,sources)
        header = '<h1>'+escape(r['title'])+'</h1><p>Source: CDC. Retrieved '+escape(r['retrieved_at'][:10])+'.</p><p><a href="'+escape(r['url'])+'">Original page [online]</a></p><p>Text edition: media omitted; captions retained.</p>'
        chapters.append((r['id'],r['title'],page(r['title'],header+body+'<p><a href="start.xhtml">Back to contents</a></p>')))
        audit.append({'id':r['id'],'sha256':r['sha256'],**details})
    manifest = '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>'
    manifest += ''.join(f'<item id="{id}" href="{id}.xhtml" media-type="application/xhtml+xml"/>' for id,_,_ in chapters)
    spine = ''.join(f'<itemref idref="{id}"/>' for id,_,_ in chapters)
    opf = f'''<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">{uid}</dc:identifier><dc:title>Field Library — Starter Edition</dc:title><dc:language>en</dc:language><dc:creator>Field Library contributors; source texts: CDC</dc:creator></metadata><manifest>{manifest}</manifest><spine toc="ncx">{spine}</spine></package>'''
    nav = ''.join(f'<navPoint id="nav-{id}" playOrder="{i}"><navLabel><text>{escape(title)}</text></navLabel><content src="{id}.xhtml"/></navPoint>' for i,(id,title,_) in enumerate(chapters,1))
    ncx = f'''<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="{uid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>Field Library</text></docTitle><navMap>{nav}</navMap></ncx>'''
    files = {'mimetype':'application/epub+zip','META-INF/container.xml':'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', 'OEBPS/content.opf':opf,'OEBPS/toc.ncx':ncx,'OEBPS/style.css':'body { font-family: serif; line-height: 1.3; } h1,h2,h3 { page-break-after: avoid; } h1 { font-size: 1.5em; } h2 { font-size: 1.25em; } table { width: 100%; border-collapse: collapse; } td,th { border: 1px solid; padding: .2em; } a { color: inherit; }'}
    files.update({'OEBPS/'+id+'.xhtml':html for id,_,html in chapters})
    for name,data in files.items():
        if name.endswith(('.xhtml','.xml','.opf','.ncx')):
            ET.fromstring(data)
    out = ROOT/'dist'
    out.mkdir(exist_ok=True)
    with ZipFile(out/'field-library.epub','w') as z:
        for name,data in files.items():
            zi=ZipInfo(name, (2000,1,1,0,0,0))
            zi.compress_type=ZIP_STORED if name=='mimetype' else ZIP_DEFLATED
            z.writestr(zi,data.encode())
    preview=out/'preview'
    preview.mkdir(exist_ok=True)
    for name,data in files.items():
        if name.startswith('OEBPS/') and name.endswith(('.xhtml','.css')):
            (preview/Path(name).name.replace('.xhtml','.html')).write_text(data.replace('.xhtml','.html'))
    (out/'audit.json').write_text(json.dumps(audit,indent=2)+'\n')
    print('Built',out/'field-library.epub')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['fetch','build'])
    parser.add_argument('--refresh',action='store_true',help='Explicitly replace source pins during fetch')
    args=parser.parse_args()
    sources=json.loads((ROOT/'sources.json').read_text())
    for s in sources:
        if not re.fullmatch('[a-z0-9-]+',s['id']) or urlsplit(s['url']).hostname!='www.cdc.gov':
            raise ValueError('Invalid source identity or host')
    if len({s['id'] for s in sources})!=len(sources):
        raise ValueError('Duplicate source IDs')
    if args.command=='fetch':
        fetch(sources,refresh=args.refresh)
    else:
        build(sources)
