#!/usr/bin/env python3
"""Explicit networked provisioning; suite.py remains entirely offline."""
import argparse
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
TOKSCALE_PIN = 'd4d1c751856e25913bce97bfbd7b254308863239'
MONITOR_PIN = 'c59a83bf943f329f0e61f1a29c760353ee1860a5'


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def checkout(url, pin, directory):
    run('git', 'init', str(directory))
    run('git', '-C', str(directory), 'remote', 'add', 'origin', url)
    run('git', '-C', str(directory), 'fetch', '--depth', '1', 'origin', pin)
    run('git', '-C', str(directory), 'checkout', '--detach', 'FETCH_HEAD')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, help='new directory for pinned tools (default: fresh temp directory)')
    parser.add_argument('--config', type=Path, default=HERE / 'tools.local.json')
    parser.add_argument('--check', action='store_true', help='validate prerequisites without downloads or writes')
    args = parser.parse_args()
    if sys.platform != 'linux' or platform.machine() != 'x86_64' or sys.version_info[:2] != (3, 12) or sys.implementation.name != 'cpython':
        parser.error('Provisioning requires Linux x64 and Python 3.12, matching the pinned comparison runner.')
    if not str(Path(sys.executable).resolve()).startswith('/usr/'):
        parser.error('Python must be inside the runner isolation mount /usr.')
    for command in ('git', 'npm', 'node', 'rustup', 'bwrap'):
        if not shutil.which(command):
            parser.error(f'Missing prerequisite: {command}')
    if not subprocess.check_output(['node', '--version'], text=True).strip().startswith('v24.'):
        parser.error('Provisioning requires Node 24, matching the comparison runner.')
    run(sys.executable, '-m', 'pip', '--version')
    # A real isolation probe avoids downloads when the host cannot run the suite.
    from run import sandbox
    sandbox([], ['/usr/bin/true'])
    if args.check:
        return
    if args.directory:
        root = args.directory.resolve()
        root.mkdir(parents=True, exist_ok=False)
    else:
        root = Path(tempfile.mkdtemp(prefix='centrail-comparison-tools-'))
    checkout('https://github.com/junhoyeo/tokscale', TOKSCALE_PIN, root / 'tokscale')
    run('rustup', 'toolchain', 'install', '1.98.0', '--profile', 'minimal')
    run(sys.executable, str(HERE / 'build.py'), '--checkout', str(root / 'tokscale'),
        '--target', str(root / 'tokscale-build'), env={**os.environ, 'RUSTUP_TOOLCHAIN': '1.98.0'})
    ccusage = root / 'ccusage'
    ccusage.mkdir()
    run('npm', 'pack', '@ccusage/ccusage-linux-x64@20.0.24', '--pack-destination', str(ccusage))
    with tarfile.open(ccusage / 'ccusage-ccusage-linux-x64-20.0.24.tgz') as archive:
        archive.extractall(ccusage, filter='data')
    binary = ccusage / 'package/bin/ccusage'
    binary.chmod(binary.stat().st_mode | 0o111)
    checkout('https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor', MONITOR_PIN, root / 'claude-monitor')
    wheels = root / 'wheels'
    run(sys.executable, '-m', 'pip', 'download', '--require-hashes', '--no-deps', '--only-binary=:all:',
        '-r', str(HERE / 'monitor-requirements.txt'), '-d', str(wheels))
    config = {
        'tokscale': {'checkout': str(root / 'tokscale'), 'binary': str(root / 'tokscale-build/debug/examples/centrail_compare')},
        'ccusage': {'binary': str(binary)},
        'claude-monitor': {'checkout': str(root / 'claude-monitor'), 'python': sys.executable,
                           'pytzWheel': str(wheels / 'pytz-2024.1-py2.py3-none-any.whl')},
    }
    args.config.write_text(json.dumps(config, indent=2) + '\n')
    print(f'Pinned tools prepared in {root}; config: {args.config.resolve()}')


if __name__ == '__main__':
    main()
