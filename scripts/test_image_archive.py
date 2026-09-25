import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("image_archive", Path(__file__).with_name("image-archive.py"))
image_archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image_archive)


class ImageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "image.tar"
        self.config = {"architecture": "arm64", "os": "linux", "config": {
            "User": "node", "Labels": {"org.opencontainers.image.version": "v1.0.0",
                                      "org.opencontainers.image.revision": "a" * 40}},
            "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "b" * 64]}}
        digest = self.write_archive(self.archive, self.config)
        self.manifest = {"kind": "DockerImage", "archive": self.archive.name,
                         "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                         "configDigest": digest, "architecture": "arm64", "version": "v1.0.0",
                         "revision": "a" * 40, "image": "fixture:v1.0.0-arm64"}
        self.manifest_path = self.root / "release.json"
        self.manifest_path.write_text(json.dumps(self.manifest))

    def write_archive(self, archive, config, oci=True):
        content = json.dumps(config).encode()
        digest = hashlib.sha256(content).hexdigest()
        name = "blobs/sha256/" + digest if oci else digest + ".json"
        with tarfile.open(archive, "w") as saved:
            for key, data in [(name, content), ("manifest.json", json.dumps([
                    {"Config": name, "RepoTags": ["fixture:v1.0.0-arm64"], "Layers": []}]).encode())]:
                member = tarfile.TarInfo(key)
                member.size = len(data)
                saved.addfile(member, io.BytesIO(data))
        return "sha256:" + digest

    def test_classic_and_containerd_ids_verify_same_content(self):
        for local_id, oci in [(self.manifest["configDigest"], False), ("sha256:" + "c" * 64, True)]:
            with self.subTest(local_id=local_id):
                def export(command, **kwargs):
                    self.assertEqual(command[-1], local_id)
                    self.write_archive(Path(command[-2]), self.config, oci)
                with patch.object(image_archive.subprocess, "check_output", return_value=json.dumps([{"Id": local_id}]).encode()), \
                     patch.object(image_archive.subprocess, "run", side_effect=export):
                    self.assertEqual(image_archive.verify_loaded(self.archive, self.manifest_path), local_id)

    def test_changed_loaded_layers_are_rejected(self):
        changed = json.loads(json.dumps(self.config))
        changed["rootfs"]["diff_ids"] = ["sha256:" + "d" * 64]
        def export(command, **kwargs):
            self.write_archive(Path(command[-2]), changed)
        with patch.object(image_archive.subprocess, "check_output", return_value=json.dumps([{"Id": "sha256:" + "c" * 64}]).encode()), \
             patch.object(image_archive.subprocess, "run", side_effect=export):
            with self.assertRaisesRegex(ValueError, "configuration digest mismatch"):
                image_archive.verify_loaded(self.archive, self.manifest_path)

    def test_checksum_failure_never_contacts_docker(self):
        with self.archive.open("ab") as archive:
            archive.write(b"modified")
        with patch.object(image_archive.subprocess, "check_output") as inspect:
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                image_archive.verify_loaded(self.archive, self.manifest_path)
            inspect.assert_not_called()

    def test_wrong_architecture_rejected(self):
        identity = image_archive.archive_identity(self.archive)
        identity["architecture"] = "amd64"
        with self.assertRaisesRegex(ValueError, "architecture mismatch"):
            image_archive.verify_content(identity, self.manifest)

    def test_legacy_manifest_still_requires_exact_configuration(self):
        legacy = dict(self.manifest)
        legacy["imageId"] = legacy.pop("configDigest")
        image_archive.verify_content(image_archive.archive_identity(self.archive), legacy)
        legacy["imageId"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "configuration digest mismatch"):
            image_archive.verify_content(image_archive.archive_identity(self.archive), legacy)


if __name__ == "__main__":
    unittest.main()
