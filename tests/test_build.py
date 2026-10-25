import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZIP_STORED
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import build

SOURCE={'id':'water','category':'Water','title':'Water & storage','url':'https://www.cdc.gov/example/index.html','publisher':'CDC'}
RAW=('''<html><div class="cdc-dfe-body__top"><h2>Key points</h2><p>'''+('Reference text. '*45)+'''</p></div><div class="cdc-dfe-body__center"><h2 id="steps">Steps</h2><ol><li>Use 5%–9%; wait 30 seconds.</li><li>Keep 50°F–70°F.</li></ol><figure><img src="photo.jpg"/><figcaption>Important caption.</figcaption></figure><p><a href="#steps">Steps</a> <a href="https://example.com">Reference</a></p><script>bad()</script></div><aside>Unwanted footer</aside></html>''').encode()

class BuildTests(unittest.TestCase):
    def test_preserves_text_and_marks_remote_links(self):
        body,audit=build.extract(RAW,SOURCE,[SOURCE])
        for text in ['5%–9%','30 seconds','50°F–70°F','Important caption.','href="#steps"','Reference [online]']:
            self.assertIn(text,body)
        self.assertNotIn('bad()',body)
        self.assertNotIn('Unwanted footer',body)
        self.assertNotIn('<img',body)
        self.assertEqual(audit['external_links'],['https://example.com'])
        ET.fromstring(build.page('Test',body))
    def test_rejects_changed_site_layout(self):
        with self.assertRaises(ValueError):
            build.extract(b'<html>Access denied</html>',SOURCE,[SOURCE])
    def test_cross_chapter_link(self):
        other={**SOURCE,'id':'other','url':'https://example.com'}
        body,audit=build.extract(RAW,SOURCE,[SOURCE,other])
        self.assertIn('href="other.xhtml"',body)
        self.assertEqual(audit['external_links'],[])
    def test_reproducible_archive_and_integrity(self):
        original=build.ROOT
        with tempfile.TemporaryDirectory() as tmp:
            try:
                build.ROOT=Path(tmp)
                (build.ROOT/'cache').mkdir()
                digest=build.sha(RAW)
                cached=build.ROOT/'cache'/(digest+'.html')
                cached.write_bytes(RAW)
                (build.ROOT/'sources.lock.json').write_text(json.dumps([{**SOURCE,'sha256':digest,'retrieved_at':'2026-10-25T00:00:00+00:00'}]))
                build.build([SOURCE])
                target=build.ROOT/'dist/field-library.epub'
                first=target.read_bytes()
                build.build([SOURCE])
                self.assertEqual(first,target.read_bytes())
                with ZipFile(target) as z:
                    self.assertEqual(z.namelist()[0],'mimetype')
                    self.assertEqual(z.getinfo('mimetype').compress_type,ZIP_STORED)
                    for name in z.namelist():
                        if name.endswith(('.xml','.xhtml','.ncx','.opf')):
                            ET.fromstring(z.read(name))
                cached.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError,'hash mismatch'):
                    build.build([SOURCE])
            finally:
                build.ROOT=original

if __name__=='__main__': unittest.main()
