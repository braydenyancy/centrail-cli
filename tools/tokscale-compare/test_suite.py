"""The gate must reject drift even when totals look plausible or tools are absent."""
import copy
import unittest
from suite import evaluate, validate_fixture


class DriftGate(unittest.TestCase):
    def setUp(self):
        self.record = {'model': 'example', 'provider': 'example', 'input': 10, 'output': 2,
                       'cacheRead': 0, 'cacheWrite': 0, 'session': 's', 'timestamp': 1}
        observation = {'projection': [self.record], 'externalIds': ['source-request'], 'issues': []}
        self.case = {'fixture': 'sample.json', 'fixtureSha256': 'fixture-hash', 'expected': [self.record],
                     'tools': {'centrail': {'status': 'executed', 'identityValid': True, 'observation': observation},
                               'rival': {'status': 'executed', 'observation': {'input': 9}, 'repeatStable': True}}}
        self.available = {'rival': {'status': 'available', 'pin': 'pinned-binary'}}
        self.baseline = {'toolPins': {'rival': 'pinned-binary'},
                         'cases': {'sample.json': {'fixtureSha256': 'fixture-hash',
                                   'tools': {tool: copy.deepcopy(value['observation']) for tool, value in self.case['tools'].items()}}}}

    def kinds(self):
        return {f['kind'] for f in evaluate([self.case], self.available, self.baseline)}

    def test_reviewed_rival_disagreement_is_not_the_source_oracle(self):
        self.assertEqual(self.kinds(), set())

    def test_source_mismatch_cannot_be_approved_by_changing_baseline(self):
        self.case['tools']['centrail']['observation'] = {'projection': [], 'externalIds': [], 'issues': []}
        self.baseline['cases']['sample.json']['tools']['centrail'] = self.case['tools']['centrail']['observation']
        self.assertIn('source_mismatch', self.kinds())

    def test_counts_matching_cannot_hide_changed_request_identity(self):
        self.case['tools']['centrail']['observation']['externalIds'] = ['different-request']
        self.assertIn('unreviewed_drift', self.kinds())

    def test_changed_rival_output_requires_review(self):
        self.case['tools']['rival']['observation']['input'] = 10
        self.assertIn('unreviewed_drift', self.kinds())

    def test_tool_upgrade_requires_review_even_with_same_output(self):
        self.available['rival']['pin'] = 'new-binary'
        self.assertIn('unreviewed_tool_pin', self.kinds())

    def test_unavailable_and_error_are_never_passing_skips(self):
        for status in ('unavailable', 'error', 'skipped'):
            with self.subTest(status=status):
                self.case['tools']['rival'] = {'status': status}
                self.assertIn(status, self.kinds())

    def test_missing_binary_is_not_a_pass(self):
        self.available['rival'] = {'status': 'unavailable', 'reason': 'not installed'}
        self.assertIn('unavailable', self.kinds())

    def test_fixture_changes_and_removal_require_review(self):
        self.case['fixtureSha256'] = 'changed-fixture'
        self.assertIn('unreviewed_fixture', self.kinds())
        self.assertIn('removed_fixture', {f['kind'] for f in evaluate([], self.available, self.baseline)})

    def test_nondeterminism_fails_even_when_one_run_matches(self):
        self.case['tools']['rival']['repeatStable'] = False
        self.assertIn('nondeterministic', self.kinds())

    def test_invalid_identity_is_not_masked_by_matching_projection(self):
        self.case['tools']['centrail']['identityValid'] = False
        self.assertIn('invalid_identity', self.kinds())

    def test_removed_competitor_and_missing_case_tool_fail(self):
        self.available = {}
        self.assertIn('removed_tool', self.kinds())
        del self.case['tools']['rival']
        self.assertIn('missing_case_tool', self.kinds())

    def test_new_not_applicable_cannot_erase_previous_coverage(self):
        self.case['tools']['rival'] = {'status': 'not_applicable', 'reason': 'unsupported'}
        self.assertIn('coverage_regression', self.kinds())
        self.baseline['cases']['sample.json']['tools']['rival'] = self.case['tools']['rival']
        self.assertNotIn('coverage_regression', self.kinds())

    def test_empty_tree_and_unexplained_empty_oracle_rejected(self):
        for files, expected in (({}, [self.record]), ({'.codex/a.jsonl': 'data'}, [])):
            with self.subTest(files=files), self.assertRaises(ValueError):
                validate_fixture({'client': 'codex', 'reason': 'test', 'provenance': {'kind': 'synthetic'},
                                  'files': files, 'expected': expected})

    def test_source_execution_cannot_be_skipped_even_in_baseline(self):
        self.case['tools']['centrail'] = {'status': 'not_applicable', 'reason': 'skip'}
        self.baseline['cases']['sample.json']['tools']['centrail'] = self.case['tools']['centrail']
        self.assertIn('missing_source_execution', self.kinds())
        del self.case['tools']['centrail']
        del self.baseline['cases']['sample.json']['tools']['centrail']
        self.assertIn('missing_source_execution', self.kinds())

    def test_fixture_cannot_escape_explicit_roots(self):
        for path in ('../outside', '/etc/passwd', '.codex/../../outside', '.ssh/config'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate_fixture({'client': 'codex', 'reason': 'test', 'provenance': {'kind': 'synthetic'},
                                  'files': {path: 'test'}, 'expected': [self.record]})


if __name__ == '__main__':
    unittest.main()
