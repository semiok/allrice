# Managed Python charts

Use this recipe with `python_execute` and actual computed labels and values. It uses the managed Matplotlib default; Office font-family names are not Matplotlib registrations. The current configured Noto CJK font includes Chinese and the Unicode minus sign. An explicitly requested unavailable font must be reported, not silently substituted.

Long categories work well on the vertical axis. `bar_label` positions positive and negative labels outside their bars; padding, axis margins and constrained layout keep them away from the category labels and figure edges. Still inspect the real PNG, particularly with more categories or unusually large values. A missing value must be handled in the analysis before plotting, not replaced by zero.

```python
import matplotlib.pyplot as plt
from matplotlib import font_manager, ft2font


def plot_cjk_bars(labels, values, *, title, unit, output_path):
    font_path = font_manager.findfont(
        font_manager.FontProperties(), fallback_to_default=False
    )
    font = ft2font.FT2Font(font_path)
    text = "".join(labels) + title + unit + "−"
    missing = sorted({char for char in text if not char.isspace()
                      and not font.get_char_index(ord(char))})
    if missing:
        raise ValueError("Configured chart font lacks glyphs: " + "".join(missing))
    fig, ax = plt.subplots(figsize=(8, 4), dpi=120, layout="constrained")
    bars = ax.barh(labels, values)
    ax.bar_label(bars, padding=4, fmt="%g")
    ax.margins(x=0.18, y=0.15)
    ax.axvline(0, color="gray", linewidth=0.6)
    ax.set_title(title)
    ax.set_xlabel(unit)
    fig.savefig(output_path, metadata={"Title": title})
    return fig, ax, font_path
```

Save to a declared output such as `/tmp/work/output/chart.png`, inspect the returned PNG and close the figure with `plt.close(fig)`. For Word/PPT, pass the returned PNG object and checksum to the Office export as an input; do not assume its sandbox has Matplotlib. Print concise facts instead of font-cache contents or repeated warnings.
