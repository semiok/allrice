import base64
import errno
import io
import subprocess
import unittest
import zipfile

from package_reader import Package


class RendererTests(unittest.TestCase):
    def package(self, entries):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as file:
            for name, content in entries:
                file.writestr(name, content)
        return buffer.getvalue()

    def test_network_filter_is_inherited_and_keeps_local_uno_pipes(self):
        # Use a disposable child: the filter is intentionally irreversible.
        code = '''from render import deny_network
import socket, errno, subprocess, sys
deny_network()
socket.socket(socket.AF_UNIX).close()
for domain in (socket.AF_INET, socket.AF_INET6):
 try:
  socket.socket(domain)
  raise AssertionError('IP socket allowed')
 except PermissionError as e:
  assert e.errno == errno.EPERM
subprocess.run([sys.executable, '-c', 'import socket; socket.socket()'], check=False, stderr=subprocess.DEVNULL).returncode == 1 or sys.exit(1)
'''
        subprocess.run(['python3', '-c', code], check=True, timeout=5)

    def test_rejects_duplicate_paths_active_content_and_external_resources(self):
        doc = ('word/document.xml', '<document/>')
        for entries in [
            [doc, doc],
            [doc, ('../outside.xml', '<root/>')],
            [doc, ('word/vbaProject.bin', 'x')],
            [doc, ('word/document.xml.rels', '<Relationships><Relationship TargetMode="External" Type="image" Target="http://private"/></Relationships>')],
            [('word/document.xml', '<!DOCTYPE x [<!ENTITY a "bad">]><document/>')],
        ]:
            with self.assertRaises(ValueError):
                Package(self.package(entries), 'docx')


if __name__ == '__main__':
    unittest.main()
