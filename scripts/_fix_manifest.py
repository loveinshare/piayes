"""删空 Beethoven 组 + 验证 manifest."""
import json
import sys
sys.stdout.reconfigure(encoding='utf-8')

p = r'D:\code\piano-follow\public\library\manifest.json'
with open(p, 'r', encoding='utf-8') as f:
    m = json.load(f)
before = len(m['groups'])
m['groups'] = [g for g in m['groups'] if g['items']]
after = len(m['groups'])
with open(p, 'w', encoding='utf-8') as f:
    json.dump(m, f, ensure_ascii=False, indent=2)
print(f'空组清理: {before} -> {after} 个组')
print('\n最终:')
for g in m['groups']:
    print(f'  {g["id"]:12s} {g["name"]:20s} {len(g["items"]):2d} 首')
print(f'\n共 {sum(len(g["items"]) for g in m["groups"])} 首')
