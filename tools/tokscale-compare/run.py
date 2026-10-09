#!/usr/bin/env python3
"""Run only the checked-in synthetic corpus in isolated Linux mount/network namespaces."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

PIN = 'd4d1c751856e25913bce97bfbd7b254308863239'
HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def command(args, **kwargs):
    result = subprocess.run([str(a) for a in args], text=True, capture_output=True,
                            timeout=120, **kwargs)
    if result.returncode:
        raise RuntimeError(f'Command failed ({result.returncode}): {args[0]}\n{result.stderr}\n{result.stdout}')
    return result.stdout


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sandbox(bindings, argv):
    args = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
            '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--chdir', '/']
    for source, target in bindings:
        args += ['--ro-bind', str(source), target]
    return command(args + ['--'] + argv, env={})


def projection(row, client, upstream):
    if upstream:
        t = row['tokens']
        # UnifiedMessage buckets are additive. Codex splits inclusive source
        # output into visible/reasoning; Pi leaves reasoning inside output.
        output = t['output'] + t['reasoning']
        return {'model': row['model_id'], 'provider': row['provider_id'],
                'input': t['input'], 'output': output,
                'cacheRead': t['cache_read'], 'cacheWrite': t['cache_write'],
                'session': row['session_id'], 'timestamp': row['timestamp']}
    session = row.get('metadata', {}).get('sessionId')
    if client in ('pi', 'gemini') and session and session.startswith(client + ':'):
        session = session[len(client) + 1:]
    return {'model': row['model'], 'provider': row['provider'],
            'input': row['inputTokens'], 'output': row['outputTokens'],
            'cacheRead': row['cacheReadTokens'], 'cacheWrite': row['cacheCreationTokens'],
            'session': session, 'timestamp': int(datetime.fromisoformat(row['occurredAt'].replace('Z', '+00:00')).timestamp() * 1000)}


def ordered(rows):
    return sorted(rows, key=lambda row: json.dumps(row, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', required=True, type=Path)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    checkout, binary = args.checkout.resolve(), args.binary.resolve()
    if command(['git', '-C', checkout, 'rev-parse', 'HEAD']).strip() != PIN:
        raise SystemExit('Wrong upstream revision')
    if command(['git', '-C', checkout, 'status', '--porcelain', '--untracked-files=no']).strip():
        raise SystemExit('Upstream tracked files modified')
    installed = checkout / 'crates/tokscale-core/examples/centrail_compare.rs'
    if not installed.is_file() or digest(installed) != digest(HERE / 'helper.rs'):
        raise SystemExit('Copy the reviewed helper before building')
    receipt_path = binary.parent.parent.parent / 'build-receipt.json'
    receipt = json.loads(receipt_path.read_text())
    expected_build = {'schemaVersion': 1, 'upstreamCommit': PIN,
                      'helperSha256': digest(HERE / 'helper.rs'),
                      'upstreamLockSha256': digest(checkout / 'Cargo.lock'),
                      'binarySha256': digest(binary)}
    if receipt != expected_build:
        raise SystemExit('Binary differs from local build receipt; rebuild with build.py')
    args.out.mkdir(parents=True, exist_ok=False)
    results = []
    with tempfile.TemporaryDirectory(prefix='centrail-tokscale-compare-') as temp:
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
            if spec['client'] not in ('codex', 'pi', 'gemini'):
                raise ValueError('Unknown fixture client')
            home = root / spec_path.stem
            home.mkdir()
            for relative, text in spec['files'].items():
                path = home / relative
                if Path(relative).is_absolute() or '..' in Path(relative).parts:
                    raise ValueError('Fixture escaped root')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            before = {str(p.relative_to(home)): digest(p) for p in home.rglob('*') if p.is_file()}
            common = [(home, '/fixtures')]
            upstream = json.loads(sandbox(common + [(binary, '/helper')],
                                          ['/helper', '/fixtures', spec['client']]))
            repeated = json.loads(sandbox(common + [(binary, '/helper')],
                                          ['/helper', '/fixtures', spec['client']]))
            if upstream.get('upstreamCommit') != PIN or upstream.get('client') != spec['client']:
                raise AssertionError('Unexpected helper protocol')
            ours = json.loads(sandbox(common + [(node, '/node'), (parsers, '/parsers'),
                                     (HERE / 'centrail.mjs', '/runner.mjs')],
                                     ['/node', '/runner.mjs', spec['client']]))
            after = {str(p.relative_to(home)): digest(p) for p in home.rglob('*') if p.is_file()}
            if before != after:
                raise AssertionError('Fixture source mutated')
            expected = ordered(spec['expected'])
            projections = {'centrail': ordered([projection(r, spec['client'], False) for r in ours['records']]),
                           'tokscale': ordered([projection(r, spec['client'], True) for r in upstream['records']])}
            differences = [{'implementation': key, 'expected': expected, 'actual': value}
                           for key, value in projections.items() if value != expected]
            result = {'fixture': spec_path.name, 'client': spec['client'],
                      'sourceReason': spec['reason'], 'fixtureSha256': digest(spec_path),
                      'sourceFiles': before, 'expected': expected,
                      'projections': projections, 'differences': differences,
                      'identity': {'centrail': [r['externalId'] for r in ours['records']],
                                   'tokscale': [r.get('dedup_key') for r in upstream['records']]},
                      'repeatStable': repeated == upstream,
                      'raw': {'centrail': ours, 'tokscale': upstream},
                      **({'repeatedTokscale': repeated} if repeated != upstream else {})}
            results.append(result)
        report = {'schemaVersion': 1, 'upstreamCommit': PIN, 'helperSha256': digest(HERE / 'helper.rs'),
                  'binarySha256': digest(binary), 'upstreamLockSha256': digest(checkout / 'Cargo.lock'),
                  'centrailSources': source_hashes,
                  'isolation': {'mechanism': 'bwrap unshare-all, clearenv, read-only fixtures, no pricing',
                                'probe': isolation},
                  'cases': results}
        (args.out / 'discrepancies.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'cases': len(results), 'discrepancies': sum(len(r['differences']) for r in results),
                          'report': str(args.out / 'discrepancies.json')}))


if __name__ == '__main__':
    main()
