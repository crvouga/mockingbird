"""Dependency-free checks: never start upstream code, services or databases."""
import unittest
from pathlib import Path
from unittest.mock import patch
from sources import definitions, verify


class SourceLoadingTests(unittest.TestCase):
    def test_transitive_definitions_preserve_behavior_without_running_startup(self):
        fixture = '''
LIMIT = 3
raise RuntimeError("unrelated gateway startup must not execute")
def helper(value):
    return value + LIMIT
def handler(value):
    return helper(value) if value else "invalid"
'''
        namespace = {}
        with patch.object(Path, "read_text", return_value=fixture):
            names = definitions("fixture.py", ["handler"], namespace)
        self.assertEqual(names, ["LIMIT", "handler", "helper"])
        self.assertEqual(namespace["handler"](4), 7)
        self.assertEqual(namespace["handler"](0), "invalid")

    def test_missing_required_definition_fails_closed(self):
        with patch.object(Path, "read_text", return_value="def different(): pass"):
            with self.assertRaisesRegex(ValueError, "Missing pinned definition: handler"):
                definitions("fixture.py", ["handler"], {})

    def test_source_tampering_fails_before_execution(self):
        with patch.object(Path, "read_bytes", return_value=b"changed source"):
            with self.assertRaisesRegex(ValueError, "Pinned source hash mismatch"):
                verify("unread-fixture")

    def test_selected_adapter_method_keeps_staticmethod_binding(self):
        fixture = '''
class APIServerAdapter:
    @staticmethod
    def header(request):
        return request["value"]
'''
        namespace = {}
        with patch.object(Path, "read_text", return_value=fixture):
            definitions("fixture.py", ["header"], namespace)
        adapter = type("Adapter", (), {"header": namespace["header"]})
        self.assertEqual(adapter().header({"value": "synthetic"}), "synthetic")


if __name__ == "__main__":
    unittest.main()
