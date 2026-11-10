#!/usr/bin/env python3
"""guard.py takes its constants from contract/rules.json, found from the file's own location (any cwd),
and refuses to load when the rules file is missing."""
import os, shutil, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))

class RulesLoading(unittest.TestCase):
    def run_py(self, code, cwd, path):
        return subprocess.run([sys.executable, "-B", "-c", f"import sys; sys.path.insert(0, {path!r}); {code}"], cwd=cwd, capture_output=True, text=True)

    def test_loads_from_any_cwd(self):
        p = self.run_py("import guard; print(guard.TEMPLATE_PAD, guard.EXIT_REFUSED)", cwd="/", path=HERE)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.split(), ["20", "3"])

    def test_symlinked_guard_still_finds_rules(self):
        with tempfile.TemporaryDirectory() as t:
            os.symlink(os.path.join(HERE, "guard.py"), os.path.join(t, "guard.py"))
            p = self.run_py("import guard; print(guard.MIN_CAP)", cwd=t, path=t)
            self.assertEqual(p.returncode, 0, p.stderr)

    def test_missing_rules_fails_closed(self):
        with tempfile.TemporaryDirectory() as t:
            shutil.copy(os.path.join(HERE, "guard.py"), t)
            p = self.run_py("import guard", cwd=t, path=t)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("contract/rules.json not found", p.stderr)

if __name__ == "__main__":
    unittest.main()
