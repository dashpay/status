import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('probe',Path(__file__).with_name('probe.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class ProbeTest(unittest.TestCase):
    def test_malformed_protobuf_is_bounded(self):
        for data in [b'\x80'*100,b'\x0a\x08a',b'\x09a',b'\x0da']:
            with self.assertRaises(ValueError): m.protobuf(data)
    def test_zero_epoch_is_valid(self):
        self.assertEqual(m.protobuf(b'\x08\x00\x10\x01'),{1:0,2:1})
if __name__=='__main__': unittest.main()
