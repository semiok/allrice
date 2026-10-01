/** Synthetic chart data and exact script used by real sandbox regressions. */
export const chartCsv =
  '项目,金额\n研发项目中文长名称（单位：元）,10\n运营维护费用（负数）,-25\n缺失金额项目,\n';
export const chartScript = `import json, warnings, hashlib
import matplotlib
import matplotlib.pyplot as plt
from matplotlib import font_manager, ft2font
import pandas as pd
from PIL import Image
warnings.simplefilter('error')
data = pd.read_csv('input/data.csv')
amounts = pd.to_numeric(data['金额'], errors='raise')
valid = data.loc[amounts.notna()].copy()
valid['金额'] = amounts.loc[amounts.notna()]
assert valid['金额'].tolist() == [10, -25]
assert amounts.isna().sum() == 1
font_path = font_manager.findfont('Noto Sans CJK JP', fallback_to_default=False)
font = ft2font.FT2Font(font_path)
assert all(font.get_char_index(ord(char)) for char in '中文图表研发项目运营费用单位元−')
fig, ax = plt.subplots(figsize=(8, 4), dpi=120)
ax.bar(valid['项目'], valid['金额'], label='费用（元）')
ax.set_title('中文费用图表：缺失金额未计入')
ax.set_ylabel('金额（元）')
ax.axhline(0, color='black', linewidth=0.5)
ax.legend()
fig.tight_layout()
fig.savefig('output/chart.png', metadata={'Title':'中文费用图表'})
plt.close(fig)
with Image.open('output/chart.png') as image:
    image.load()
    assert image.size == (960, 480)
    assert image.info['Title'] == '中文费用图表'
facts = {'rows':len(data), 'plotted':len(valid), 'missing':int(amounts.isna().sum()),
    'values':valid['金额'].tolist(), 'sum':int(valid['金额'].sum()),
    'backend':matplotlib.get_backend(), 'font':font_path,
    'font_checksum':'sha256:'+hashlib.sha256(open(font_path,'rb').read()).hexdigest()}
open('output/data-quality.json','w').write(json.dumps(facts, ensure_ascii=False))
print(json.dumps(facts, ensure_ascii=False))
`;
