"""Run the actual pinned monitor reader; invoked only within the fixture sandbox."""
import dataclasses
import json
import sys

# -I -S ignores user site packages and environment Python paths. Only the
# pinned source plus the explicitly verified pytz dependency is added.
sys.path[:0] = ['/monitor/src', '/deps']
from claude_monitor.core.models import CostMode
from claude_monitor.data.reader import load_usage_entries

entries, _ = load_usage_entries(data_path='/fixtures/.claude/projects',
                                hours_back=None, mode=CostMode.CALCULATED,
                                include_raw=False, filter_models='all')
rows = []
for entry in entries:
    row = dataclasses.asdict(entry)
    row['timestamp'] = entry.timestamp.isoformat()
    rows.append(row)
print(json.dumps(rows, sort_keys=True, separators=(',', ':'), allow_nan=False))
