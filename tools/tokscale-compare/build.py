#!/usr/bin/env python3
"""Build the pinned helper without modifying tracked upstream files or accessing logs."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
from run import HERE, PIN, command, digest

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--checkout', required=True, type=Path)
parser.add_argument('--target', required=True, type=Path)
parser.add_argument('--cargo', default='cargo')
parser.add_argument('--offline', action='store_true')
args = parser.parse_args()
checkout, target = args.checkout.resolve(), args.target.resolve()
if command(['git', '-C', checkout, 'rev-parse', 'HEAD']).strip() != PIN:
    raise SystemExit('Wrong upstream revision')
if command(['git', '-C', checkout, 'status', '--porcelain', '--untracked-files=no']).strip():
    raise SystemExit('Upstream tracked files modified')
example = checkout / 'crates/tokscale-core/examples/centrail_compare.rs'
example.parent.mkdir(exist_ok=True)
shutil.copyfile(HERE / 'helper.rs', example)
cmd = [args.cargo, 'build', '--locked', '--manifest-path', str(checkout / 'Cargo.toml'),
       '-p', 'tokscale-core', '--example', 'centrail_compare']
if args.offline:
    cmd.append('--offline')
rustc_version = command([os.environ.get('RUSTC', 'rustc'), '--version']).strip()
if not rustc_version.startswith('rustc 1.98.0 '):
    raise SystemExit('The pinned helper requires rustc 1.98.0; select it explicitly')
subprocess.run(cmd, env={**os.environ, 'CARGO_TARGET_DIR': str(target)}, check=True)
(target / 'compiler-provenance.json').write_text(json.dumps({'rustcVersion': rustc_version,
    'cargoVersion': command([args.cargo, '--version']).strip()}, indent=2) + '\n')
binary = target / 'debug/examples/centrail_compare'
receipt = {'schemaVersion': 1, 'upstreamCommit': PIN, 'helperSha256': digest(HERE / 'helper.rs'),
           'upstreamLockSha256': digest(checkout / 'Cargo.lock'), 'binarySha256': digest(binary)}
(target / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(binary)
