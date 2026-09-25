"""Verify Docker-save content independently of the daemon's image-ID format."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def archive_identity(archive):
    with tarfile.open(archive, "r:*") as saved:
        def read(name, limit):
            member = saved.getmember(name)
            require(member.isfile() and member.size <= limit, "Invalid image metadata member")
            return saved.extractfile(member).read()

        manifests = json.loads(read("manifest.json", 1024 * 1024))
        require(len(manifests) == 1, "Expected exactly one image")
        content = read(manifests[0]["Config"], 4 * 1024 * 1024)
        config = json.loads(content)
        return {
            "configDigest": "sha256:" + hashlib.sha256(content).hexdigest(),
            "architecture": config["architecture"],
            "os": config["os"],
            "labels": config["config"].get("Labels", {}),
            "user": config["config"].get("User", ""),
        }


def verify_content(identity, manifest):
    # v0.1.0-rc.2 called the classic builder's config digest imageId. Accept it
    # only when it matches the actual archive/loaded bytes, never as a tag bypass.
    digest = manifest.get("configDigest", manifest.get("imageId"))
    require(identity["configDigest"] == digest, "Image configuration digest mismatch")
    require(identity["architecture"] == manifest["architecture"], "Image architecture mismatch")
    require(identity["os"] == "linux", "Expected Linux image")
    require(identity["user"] == "node", "Expected non-root application user")
    for label, value in {"version": manifest["version"], "revision": manifest["revision"]}.items():
        require(identity["labels"].get("org.opencontainers.image." + label) == value,
                "Image release identity mismatch")


def verify_loaded(archive, manifest_path):
    manifest = json.loads(Path(manifest_path).read_text())
    require(manifest["kind"] == "DockerImage", "Expected Docker image manifest")
    require(Path(archive).name == manifest["archive"], "Archive filename mismatch")
    with open(archive, "rb") as stream:
        require(hashlib.file_digest(stream, "sha256").hexdigest() == manifest["sha256"],
                "Archive checksum mismatch")
    verify_content(archive_identity(archive), manifest)
    inspection = json.loads(subprocess.check_output(
        ["docker", "image", "inspect", manifest["image"]]))
    require(len(inspection) == 1, "Expected one loaded image")
    image_id = inspection[0]["Id"]
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_id), "Invalid local image ID")
    # Classic stores expose the config digest; containerd stores may expose the
    # manifest digest. Export the immutable local ID, not its mutable tag, and
    # compare the exact config bytes (which include all rootfs layer diff IDs).
    with tempfile.TemporaryDirectory(prefix="status-image-verify-") as temp:
        exported = str(Path(temp) / "loaded.tar")
        subprocess.run(["docker", "image", "save", "--output", exported, image_id], check=True)
        verify_content(archive_identity(exported), manifest)
    return image_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["identity", "verify"])
    parser.add_argument("archive")
    parser.add_argument("manifest", nargs="?")
    args = parser.parse_args()
    if args.command == "identity":
        print(json.dumps(archive_identity(args.archive)))
    else:
        require(args.manifest, "A release manifest is required")
        print(verify_loaded(args.archive, args.manifest))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f"Image verification failed: {error}", file=sys.stderr)
        sys.exit(1)
