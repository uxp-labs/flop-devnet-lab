#!/usr/bin/env python3
"""build-lane.py takes its shared labels from contract/rules.json, found from the file's own location
(any cwd), and refuses to build when the rules file is missing."""
import json, os, shutil, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

class RulesLoading(unittest.TestCase):
    def build(self, viewer_dir, cwd):
        return subprocess.run([sys.executable, "-B", os.path.join(viewer_dir, "build-lane.py")], cwd=cwd, capture_output=True, text=True)

    def test_builds_from_any_cwd_with_rules_beside(self):
        with tempfile.TemporaryDirectory() as t:
            shutil.copytree(HERE, os.path.join(t, "viewer"), ignore=shutil.ignore_patterns("__pycache__"))
            os.mkdir(os.path.join(t, "contract")); shutil.copy(os.path.join(ROOT, "contract", "rules.json"), os.path.join(t, "contract"))
            p = self.build(os.path.join(t, "viewer"), cwd="/")
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(os.path.join(t, "viewer", "settlement-viewer-2026-11-09.html")) as a, open(os.path.join(HERE, "settlement-viewer-2026-11-09.html")) as b:
                self.assertEqual(a.read(), b.read())

    def test_labels_come_from_rules(self):
        with tempfile.TemporaryDirectory() as t:
            shutil.copytree(HERE, os.path.join(t, "viewer"), ignore=shutil.ignore_patterns("__pycache__"))
            os.mkdir(os.path.join(t, "contract"))
            with open(os.path.join(ROOT, "contract", "rules.json")) as fh: rules = json.load(fh)
            rules["constants"]["IDENTITY"]["value"] = "PROBE-IDENTITY-LABEL"
            with open(os.path.join(t, "contract", "rules.json"), "w") as fh: json.dump(rules, fh)
            p = self.build(os.path.join(t, "viewer"), cwd=t)
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(os.path.join(t, "viewer", "settlement-viewer-2026-11-09.html")) as fh: self.assertIn("PROBE-IDENTITY-LABEL", fh.read())

    def test_missing_rules_fails_closed(self):
        with tempfile.TemporaryDirectory() as t:
            shutil.copytree(HERE, os.path.join(t, "viewer"), ignore=shutil.ignore_patterns("__pycache__"))
            before = open(os.path.join(t, "viewer", "settlement-viewer-2026-11-09.html")).read()
            p = self.build(os.path.join(t, "viewer"), cwd=t)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("contract/rules.json not found", p.stderr)
            self.assertEqual(open(os.path.join(t, "viewer", "settlement-viewer-2026-11-09.html")).read(), before)

if __name__ == "__main__":
    unittest.main()
