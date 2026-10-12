#!/usr/bin/env python3
"""Offline source-oracle and reviewed-baseline drift gate over shared fixture trees."""
import argparse
import importlib
import json
from pathlib import Path
import shutil
import tempfile
import sys
from run import HERE, REPO, PIN, command, digest, sandbox, projection, ordered

CLIENTS = ('claude', 'codex', 'pi', 'gemini', 'copilot')
ADAPTERS = {'ccusage': 'ccusage_adapter', 'claude-monitor': 'claude_monitor_adapter'}


def tok_available(config):
    try:
        checkout = Path(config['checkout']).resolve()
        binary = Path(config['binary']).resolve()
        if command(['git', '-C', checkout, 'rev-parse', 'HEAD']).strip() != PIN:
            raise ValueError('wrong upstream revision')
        if command(['git', '-C', checkout, 'status', '--porcelain', '--untracked-files=no']).strip():
            raise ValueError('modified tracked upstream files')
        installed = checkout / 'crates/tokscale-core/examples/centrail_compare.rs'
        if digest(installed) != digest(HERE / 'helper.rs'):
            raise ValueError('helper changed; rebuild')
        receipt = json.loads((binary.parent.parent.parent / 'build-receipt.json').read_text())
        expected = {'schemaVersion': 1, 'upstreamCommit': PIN, 'helperSha256': digest(HERE / 'helper.rs'),
                    'upstreamLockSha256': digest(checkout / 'Cargo.lock'), 'binarySha256': digest(binary)}
        if receipt != expected:
            raise ValueError('binary/build receipt mismatch')
        return {'status': 'available', 'pin': {k: v for k, v in expected.items() if k != 'binarySha256'},
                'executionEvidence': {'binarySha256': expected['binarySha256'],
                    'compiler': json.loads((binary.parent.parent.parent / 'compiler-provenance.json').read_text())}}
    except Exception as error:
        return {'status': 'unavailable', 'reason': str(error)}


def validate_fixture(spec):
    if spec['client'] not in CLIENTS or not spec.get('provenance') or not spec.get('reason'):
        raise ValueError('fixture requires supported client, source reason and provenance')
    if not isinstance(spec.get('files'), dict) or not spec['files'] or not isinstance(spec.get('expected'), list):
        raise ValueError('fixture requires nonempty file tree and explicit expected record list')
    if not spec['expected'] and not spec.get('expectEmptyReason'):
        raise ValueError('empty expected records require explicit quarantine/empty-source reason')
    required = {'model', 'provider', 'input', 'output', 'cacheRead', 'cacheWrite', 'session', 'timestamp'}
    for row in spec['expected']:
        if not isinstance(row, dict) or set(row) != required:
            raise ValueError('invalid expected record shape')
        if any(isinstance(row[k], bool) or not isinstance(row[k], int) or row[k] < 0
               for k in ('input', 'output', 'cacheRead', 'cacheWrite', 'timestamp')):
            raise ValueError('invalid expected numeric field')
        if any(not isinstance(row[k], str) or not row[k] for k in ('model', 'provider')):
            raise ValueError('invalid expected identity field')
    for path, content in spec['files'].items():
        if '\\' in path or ':' in path or Path(path).is_absolute() or '..' in Path(path).parts or not isinstance(content, str):
            raise ValueError('invalid fixture path/content')
        if not path.startswith(('.claude/', '.codex/', '.pi/', '.gemini/', '.copilot/')):
            raise ValueError('fixture outside explicit client roots')


def evaluate(cases, availability, baseline):
    """Missing tools/baselines never pass; the source oracle is independent of baselines."""
    failures = []
    for tool, ready in availability.items():
        if ready['status'] != 'available':
            failures.append({'kind': 'unavailable', 'tool': tool, 'reason': ready.get('reason')})
        elif baseline.get('toolPins', {}).get(tool) != ready['pin']:
            failures.append({'kind': 'unreviewed_tool_pin', 'tool': tool})
    for removed in set(baseline.get('toolPins', {})) - set(availability):
        failures.append({'kind': 'removed_tool', 'tool': removed})
    known = baseline.get('cases', {})
    seen = set()
    for case in cases:
        name = case['fixture']
        seen.add(name)
        reviewed = known.get(name, {})
        if case['tools'].get('centrail', {}).get('status') != 'executed':
            failures.append({'kind': 'missing_source_execution', 'fixture': name})
        for required_tool in set(availability) - set(case['tools']):
            failures.append({'kind': 'missing_case_tool', 'fixture': name, 'tool': required_tool})
        if reviewed.get('fixtureSha256') != case['fixtureSha256']:
            failures.append({'kind': 'unreviewed_fixture', 'fixture': name})
        for missing in set(reviewed.get('tools', {})) - set(case['tools']):
            failures.append({'kind': 'missing_case_tool', 'fixture': name, 'tool': missing})
        for tool, result in case['tools'].items():
            if result['status'] == 'not_applicable':
                if reviewed.get('tools', {}).get(tool) != {'status': 'not_applicable', 'reason': result['reason']}:
                    failures.append({'kind': 'coverage_regression', 'fixture': name, 'tool': tool})
                continue
            if result['status'] != 'executed':
                failures.append({'kind': result['status'], 'fixture': name, 'tool': tool})
                continue
            if not result.get('repeatStable', True):
                failures.append({'kind': 'nondeterministic', 'fixture': name, 'tool': tool})
            if tool == 'centrail' and result['observation']['projection'] != ordered(case['expected']):
                failures.append({'kind': 'source_mismatch', 'fixture': name, 'tool': tool})
            if tool == 'centrail' and not result['identityValid']:
                failures.append({'kind': 'invalid_identity', 'fixture': name, 'tool': tool})
            if reviewed.get('tools', {}).get(tool) != result['observation']:
                failures.append({'kind': 'unreviewed_drift', 'fixture': name, 'tool': tool})
    for removed in sorted(set(known) - seen):
        failures.append({'kind': 'removed_fixture', 'fixture': removed})
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=HERE / 'tools.local.json')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--baseline', type=Path, default=HERE / 'baseline.json')
    args = parser.parse_args()
    config = json.loads(args.config.read_text()) if args.config.exists() else {}
    baseline = json.loads(args.baseline.read_text()) if args.baseline.exists() else {}
    out = args.out or Path(tempfile.mkdtemp(prefix='centrail-comparison-report-'))
    if args.out:
        out.mkdir(parents=True, exist_ok=False)
    availability = {'tokscale': tok_available(config.get('tokscale', {}))}
    adapters = {}
    for name, module in ADAPTERS.items():
        try:
            adapters[name] = importlib.import_module(module)
            availability[name] = adapters[name].availability(config.get(name, {}))
        except Exception as error:
            availability[name] = {'status': 'unavailable', 'reason': str(error)}
    protocol = {p.name: digest(p) for p in sorted(HERE.iterdir())
                if p.suffix in ('.py', '.rs', '.mjs') and not p.name.startswith('test_')}
    cases = []
    infrastructure_error = None
    try:
        with tempfile.TemporaryDirectory(prefix='centrail-comparison-') as temp:
            root = Path(temp)
            parsers = root / 'parsers'
            command(['node', REPO / 'node_modules/typescript/bin/tsc', '-p',
                     REPO / 'packages/parsers/tsconfig.json', '--outDir', parsers])
            (parsers / 'package.json').write_text('{"type":"module"}\n')
            node = Path(shutil.which('node')).resolve()
            isolation = json.loads(sandbox([], ['/usr/bin/python3', '-c',
                "import errno,json,os,socket; assert not os.path.exists('/home'); "
                "s=socket.socket(); result=s.connect_ex(('192.0.2.1',443)); "
                "assert result==errno.ENETUNREACH,result; "
                "print(json.dumps({'homeAbsent':True,'networkConnectErrno':result}))"]))
            source_hashes = {str(p.relative_to(REPO)): digest(p)
                             for p in sorted((REPO / 'packages/parsers/src').rglob('*.ts'))}
            for spec_path in sorted((HERE / 'fixtures').glob('*.json')):
                spec = json.loads(spec_path.read_text())
                validate_fixture(spec)
                home = root / spec_path.stem
                home.mkdir()
                for relative, text in spec['files'].items():
                    path = home / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(text)
                before = {str(p.relative_to(home)): digest(p) for p in home.rglob('*') if p.is_file()}
                common = [(home, '/fixtures')]
                case = {'fixture': spec_path.name, 'client': spec['client'], 'provenance': spec['provenance'],
                        'sourceReason': spec['reason'], 'fixtureSha256': digest(spec_path),
                        'sourceFiles': before, 'expected': spec['expected'], 'tools': {}}
                try:
                    def execute_ours():
                        return json.loads(sandbox(common + [(node, '/node'), (parsers, '/parsers'),
                            (HERE / 'centrail.mjs', '/runner.mjs')], ['/usr/bin/env', 'HOME=/fixtures', '/node', '/runner.mjs', spec['client']]))
                    ours = execute_ours()
                    repeated_ours = execute_ours()
                    ids = [r.get('externalId') for r in ours['records']]
                    case['tools']['centrail'] = {'status': 'executed', 'repeatStable': ours == repeated_ours,
                        'identityValid': all(isinstance(i, str) and i for i in ids) and len(ids) == len(set(ids)),
                        'observation': {'projection': ordered([projection(r, spec['client'], False) for r in ours['records']]),
                                        'externalIds': sorted(ids), 'issues': ordered(ours.get('issues', []))}, 'raw': ours}
                except Exception as error:
                    case['tools']['centrail'] = {'status': 'error', 'reason': str(error)}
                for tool in ('tokscale', *ADAPTERS):
                    if availability[tool]['status'] != 'available':
                        case['tools'][tool] = {'status': 'unavailable', 'reason': availability[tool].get('reason')}
                        continue
                    if tool != 'tokscale' and spec['client'] not in adapters[tool].SUPPORTED_CLIENTS:
                        case['tools'][tool] = {'status': 'not_applicable', 'reason': 'client unsupported by pinned tool'}
                        continue
                    try:
                        if tool == 'tokscale':
                            binary = Path(config['tokscale']['binary']).resolve()
                            def execute():
                                raw = json.loads(sandbox(common + [(binary, '/helper')], ['/helper', '/fixtures', spec['client']]))
                                if raw.get('upstreamCommit') != PIN or raw.get('client') != spec['client']:
                                    raise ValueError('unexpected Tokscale protocol')
                                return {'status': 'executed', 'observation': {'records': ordered(raw['records']),
                                        'projection': ordered([projection(r, spec['client'], True) for r in raw['records']])}, 'raw': raw}
                        else:
                            def execute():
                                return adapters[tool].execute(config[tool], spec, home, sandbox)
                        result = execute()
                        repeated = execute()
                        result['repeatStable'] = result.get('observation') == repeated.get('observation')
                        if not result['repeatStable']:
                            result['repeatedObservation'] = repeated.get('observation')
                        case['tools'][tool] = result
                    except Exception as error:
                        case['tools'][tool] = {'status': 'error', 'reason': str(error)}
                after = {str(p.relative_to(home)): digest(p) for p in home.rglob('*') if p.is_file()}
                if before != after:
                    raise AssertionError('fixture source mutated')
                cases.append(case)
    except Exception as error:
        infrastructure_error = str(error)
    failures = evaluate(cases, availability, baseline)
    if baseline.get('protocol') != protocol:
        failures.append({'kind': 'unreviewed_protocol'})
    if infrastructure_error:
        failures.append({'kind': 'infrastructure_error', 'reason': infrastructure_error})
    if not cases:
        failures.append({'kind': 'empty_suite'})
    report = {'schemaVersion': 1, 'status': 'failed' if failures else 'passed', 'availability': availability, 'protocol': protocol,
              'isolation': locals().get('isolation'), 'centrailSources': locals().get('source_hashes'),
              'baselineSha256': digest(args.baseline) if args.baseline.exists() else None,
              'cases': cases, 'failures': failures}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    # This is evidence for explicit review, never automatically activated.
    candidate = {'schemaVersion': 1, 'protocol': protocol, 'toolPins': {t: a['pin'] for t, a in availability.items() if a['status'] == 'available'},
                 'cases': {c['fixture']: {'fixtureSha256': c['fixtureSha256'],
                           'tools': {t: (r['observation'] if r['status'] == 'executed' else {'status': 'not_applicable', 'reason': r['reason']})
                                     for t, r in c['tools'].items() if r['status'] in ('executed', 'not_applicable')}} for c in cases}}
    (out / 'baseline-candidate.json').write_text(json.dumps(candidate, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'cases': len(cases), 'failures': len(failures), 'report': str(out / 'report.json')}))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
