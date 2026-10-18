#!/usr/bin/env python3
"""汇总脱敏资源样本；不读取运行secret。每次输出明确样本范围。"""
import json
from pathlib import Path
import re
import statistics

HERE = Path(__file__).resolve().parent
MIB = 1024 * 1024


def memory(text):
    match = re.match(r'([0-9.]+)([A-Za-z]+)', text.strip())
    if not match:
        return 0
    return float(match[1]) * {'B': 1, 'kB': 1000, 'KB': 1000, 'KiB': 1024,
        'MB': 10**6, 'MiB': MIB, 'GB': 10**9, 'GiB': 1024**3}.get(match[2], 1)


def meminfo(row, key):
    match = re.search(r'^' + key + r':\s+(\d+) kB', row['vmRaw'], re.M)
    return int(match[1]) * 1024 if match else None


def metrics(row):
    values = {'dockerCpuCores': sum(float(x['CPUPerc'].rstrip('%')) / 100
                                 for x in row['dockerStats']),
              'dockerWorkingSetBytes': sum(memory(x['MemUsage'].split('/')[0])
                                          for x in row['dockerStats']),
              'vmMemAvailableBytes': meminfo(row, 'MemAvailable'),
              'vmMemTotalBytes': meminfo(row, 'MemTotal'),
              'clusterConnections': row['postgres']['connections']}
    values['cgroupCurrentBytes'] = 0
    values['procRssSumBytes'] = 0
    for container in row['containers']:
        data = container.get('procAndCgroup', '').splitlines()
        if len(data) >= 3 and data[0].isdigit() and data[1].isdigit():
            values['procRssSumBytes'] += int(data[0]) * 1024
            values['cgroupCurrentBytes'] += int(data[1])
    return values


def cpu_ticks(row):
    match = re.search(r'^cpu\s+([\d ]+)$', row['vmRaw'], re.M)
    fields = list(map(int, match[1].split())) if match else []
    # guest/guest_nice已包含在user/nice，不重复相加；iowait单独视作非busy。
    return (sum(fields[:8]), sum(fields[:3]) + sum(fields[5:8])) if len(fields) >= 8 else None


def summarize(rows):
    points = [metrics(row) for row in rows]
    result = {'samples': len(rows), 'firstAt': rows[0]['observedAt'], 'lastAt': rows[-1]['observedAt']}
    for key in points[0]:
        values = [point[key] for point in points if point[key] is not None]
        result[key] = {'min': min(values), 'max': max(values), 'median': statistics.median(values)}
    result['walLsnDeltaBytes'] = rows[-1]['postgres']['walBytes'] - rows[0]['postgres']['walBytes']
    result['oomKilledContainers'] = sorted({c['service'] for r in rows for c in r['containers'] if c['oomKilled']})
    result['oomEvents'] = max([int(m.group(1)) for r in rows for c in r['containers']
                              for m in [re.search(r'^oom (\d+)$', c.get('procAndCgroup', ''), re.M)] if m] or [0])
    result['oomKillEvents'] = max([int(m.group(1)) for r in rows for c in r['containers']
                                  for m in [re.search(r'^oom_kill (\d+)$', c.get('procAndCgroup', ''), re.M)] if m] or [0])
    return result


def main():
    rows = [json.loads(line) for line in (HERE / 'b-1.9-resources.jsonl').read_text().splitlines()]
    rows.sort(key=lambda row: row['observedAt'])
    by_phase = {}
    for row in rows:
        full = all(any(c['service'] == name and c['running'] for c in row['containers'])
                   for name in ['object-storage', 'backup'])
        key = row['phase'] + (':storage+backup' if full else ':core')
        by_phase.setdefault(key, []).append(row)
    vm_cpu = []
    for previous, current in zip(rows, rows[1:]):
        a, b = cpu_ticks(previous), cpu_ticks(current)
        if a and b and b[0] > a[0]:
            vm_cpu.append({'until': current['observedAt'], 'cpuCores': 2 * (b[1] - a[1]) / (b[0] - a[0])})
    services = {}
    for row in rows:
        for container in row['containers']:
            service = container['service']
            values = services.setdefault(service, {'cgroupPeakBytes': 0, 'procRssPeakBytes': 0,
                                                    'maxObservedRestartCount': 0, 'observedContainerIds': []})
            data = container.get('procAndCgroup', '').splitlines()
            if len(data) >= 3 and data[0].isdigit() and data[2].isdigit():
                values['cgroupPeakBytes'] = max(values['cgroupPeakBytes'], int(data[2]))
                values['procRssPeakBytes'] = max(values['procRssPeakBytes'], int(data[0]) * 1024)
            values['maxObservedRestartCount'] = max(values['maxObservedRestartCount'], container['restartCount'])
            if container['id'] not in values['observedContainerIds']:
                values['observedContainerIds'].append(container['id'])
    result = {'method': {'boundary': 'Colima 2 vCPU/4GiB entire VM',
        'dockerCpu': '100 percent = one core; sum uses same docker stats observation',
        'rss': 'sum of process VmRSS per container; PG shared pages are counted repeatedly',
        'cgroupPeak': 'per-container high water, including file cache; peaks are not simultaneous',
        'wal': 'cluster LSN delta includes forced archive segment padding; actual wal record bytes are separate',
        'vmCpu': 'difference of /proc/stat across adjacent samples; includes OS/daemon, interval average'},
        'overall': summarize(rows), 'phases': {phase: summarize(data) for phase, data in by_phase.items()},
        'serviceHighWater': services, 'vmCpuIntervals': vm_cpu}
    (HERE / 'b-1.9-resource-summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['overall']))


if __name__ == '__main__':
    main()
