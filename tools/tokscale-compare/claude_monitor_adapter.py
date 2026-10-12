"""Actual pinned claude-monitor reader over synthetic Claude fixtures only."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile
import io

SUPPORTED_CLIENTS = ('claude',)
COMMIT = 'c59a83bf943f329f0e61f1a29c760353ee1860a5'
PYTZ_SHA256 = '328171f4e3623139da4983451950b28e95ac706e13f3f2630a879749e7a8b319'
HELPER = Path(__file__).with_name('claude_monitor_helper.py')


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def availability(config):
    pin = {'commit': COMMIT, 'version': '4.0.0', 'pytzVersion': '2024.1',
           'pytzWheelSha256': PYTZ_SHA256, 'pythonContract': 'CPython 3.12', 'helperSha256': digest(HELPER),
           'adapterSha256': digest(Path(__file__))}
    try:
        checkout = Path(config['checkout']).resolve()
        python = Path(config.get('python', '/usr/bin/python3')).resolve()
        if not str(python).startswith('/usr/'):
            raise ValueError('Interpreter must be inside the sandbox /usr mount')
        def git(*args):
            return subprocess.check_output(['git', '-C', str(checkout), *args], text=True).strip()
        if git('rev-parse', 'HEAD') != COMMIT:
            raise ValueError('Wrong monitor commit')
        if git('status', '--porcelain', '--untracked-files=all'):
            raise ValueError('Monitor checkout must be clean, including untracked files')
        wheel = Path(config['pytzWheel']).resolve()
        if digest(wheel) != PYTZ_SHA256:
            raise ValueError('Pinned pytz wheel unavailable or changed')
        runtime = json.loads(subprocess.check_output([str(python), '-I', '-S', '-c',
            'import sys,json; print(json.dumps({"implementation":sys.implementation.name,"version":list(sys.version_info[:3])}))'], text=True))
        if runtime['implementation'] != 'cpython' or runtime['version'][:2] != [3, 12]:
            raise ValueError('Monitor adapter requires CPython 3.12')
        return {'status': 'available', 'pin': pin}
    except Exception as error:
        return {'status': 'unavailable', 'pin': pin, 'reason': str(error)}


def execute(config, spec, home, sandbox):
    ready = availability(config)
    if ready['status'] != 'available':
        return ready
    if spec['client'] not in SUPPORTED_CLIENTS:
        return {'status': 'unavailable', 'reason': 'Monitor supports only Claude JSONL fixtures'}
    checkout = Path(config['checkout']).resolve()
    python = Path(config.get('python', '/usr/bin/python3')).resolve()
    # Verify immutable wheel bytes, then unpack into a temporary dependency
    # mount. No pip execution, user site packages or system bytecode at runtime.
    wheel_bytes = Path(config['pytzWheel']).read_bytes()
    if hashlib.sha256(wheel_bytes).hexdigest() != PYTZ_SHA256:
        raise ValueError('Pinned dependency changed before preparation')
    with tempfile.TemporaryDirectory(prefix='centrail-monitor-deps-') as scratch:
        deps = Path(scratch)
        with zipfile.ZipFile(io.BytesIO(wheel_bytes)) as wheel:
            for member in wheel.infolist():
                path = Path(member.filename)
                if path.is_absolute() or '..' in path.parts:
                    raise ValueError('Unsafe wheel path')
                if member.is_dir():
                    continue
                target = deps / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(wheel.read(member))
        raw = json.loads(sandbox([(home, '/fixtures'), (checkout / 'src', '/monitor/src'),
                                  (deps, '/deps'), (HELPER, '/monitor-helper.py')],
                                 [str(python), '-I', '-S', '-B', '/monitor-helper.py']))
    fields = {'input': 'input_tokens', 'output': 'output_tokens',
              'cacheRead': 'cache_read_tokens', 'cacheWrite': 'cache_creation_tokens'}
    totals = {key: sum(row[field] for row in raw) for key, field in fields.items()}
    expected = {key: sum(row[key] for row in spec['expected']) for key in fields}
    # Preserve all native reader fields, including request/message IDs and
    # source account. Do not manufacture a session ID the reader omits.
    records = sorted(raw, key=lambda row: json.dumps(row, sort_keys=True))
    return {'status': 'executed', 'pin': ready['pin'], 'raw': raw,
            'executionProvenance': {'pythonSha256': digest(python),
                'pythonVersion': subprocess.check_output([str(python), '--version'], text=True).strip()},
            'observation': {'records': records, 'aggregate': totals,
                            'sessionIdentity': 'not exposed by UsageEntry',
                            'costBasis': 'upstream built-in calculated estimate; not a billing oracle'},
            'sourceComparison': {'expected': expected, 'actual': totals, 'matches': totals == expected}}
