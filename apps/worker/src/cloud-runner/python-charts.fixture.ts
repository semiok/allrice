import { readFileSync } from 'node:fs';

/** Exercise the actual Run-frozen Skill recipe in the sandbox regression. */
const chartGuide = readFileSync(
  new URL('../../../../skills/office/references/charts.md', import.meta.url),
  'utf8',
);
const chartRecipe = chartGuide.match(/```python\n([\s\S]+?)```/)?.[1];
if (!chartRecipe) throw new Error('office_chart_recipe_missing');

/** Synthetic chart data and exact script used by real sandbox regressions. */
export const chartCsv =
  '项目,金额\n研发项目中文长名称（单位：元）,10\n运营维护费用（负数）,-25\n缺失金额项目,\n';
export const chartScript = `import json, warnings, hashlib
import matplotlib
import matplotlib.pyplot as plt
import pandas as pd
from PIL import Image
warnings.simplefilter('error')
${chartRecipe}
data = pd.read_csv('input/data.csv')
amounts = pd.to_numeric(data['金额'], errors='raise')
valid = data.loc[amounts.notna()].copy()
valid['金额'] = amounts.loc[amounts.notna()]
assert valid['金额'].tolist() == [10, -25]
assert amounts.isna().sum() == 1
fig, ax, font_path = plot_cjk_bars(valid['项目'].tolist(), valid['金额'].tolist(),
    title='中文费用图表', unit='金额（元）；缺失金额未计入', output_path='output/chart.png')
fig.canvas.draw()
renderer = fig.canvas.get_renderer()
value_boxes = [text.get_window_extent(renderer) for text in ax.texts]
category_boxes = [text.get_window_extent(renderer) for text in ax.get_yticklabels()]
assert all(not value.overlaps(category) for value in value_boxes for category in category_boxes)
assert all(fig.bbox.contains(box.x0, box.y0) and fig.bbox.contains(box.x1, box.y1)
    for box in value_boxes + category_boxes)
plt.close(fig)
with Image.open('output/chart.png') as image:
    image.load()
    assert image.size == (960, 480)
    assert image.info['Title'] == '中文费用图表'
facts = {'rows':len(data), 'plotted':len(valid), 'missing':int(amounts.isna().sum()),
    'values':valid['金额'].tolist(), 'sum':int(valid['金额'].sum()),
    'backend':matplotlib.get_backend(), 'font':font_path, 'labels_overlap':False,
    'font_checksum':'sha256:'+hashlib.sha256(open(font_path,'rb').read()).hexdigest()}
open('output/data-quality.json','w').write(json.dumps(facts, ensure_ascii=False))
print(json.dumps(facts, ensure_ascii=False))
`;
