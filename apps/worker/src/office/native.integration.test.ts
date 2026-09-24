import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CloudCommandInputSchema } from '@allrice/contracts';
import { CloudRunnerBackend } from '../cloud-runner/backend.js';

const cases = {
  docx: `from docx import Document\nfrom docx.shared import RGBColor\nfrom docx.enum.text import WD_ALIGN_PARAGRAPH\nd=Document(); d.sections[0].header.paragraphs[0].text='内部审阅'; p=d.add_heading('2026年9月复核报告',0); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.runs[0].font.color.rgb=RGBColor.from_string('0070C0'); d.add_paragraph('客户：青禾科技'); d.save('/tmp/work/output/result.docx')\nd=Document('/tmp/work/output/result.docx'); assert d.sections[0].header.paragraphs[0].text=='内部审阅'; assert d.paragraphs[0].alignment==WD_ALIGN_PARAGRAPH.CENTER`,
  xlsx: `from openpyxl import Workbook,load_workbook\nfrom openpyxl.chart import BarChart,Reference\nfrom openpyxl.formatting.rule import CellIsRule\nfrom openpyxl.styles import PatternFill\nw=Workbook(); s=w.active; s.title='明细'; s.append(['编号','金额','合计']);\nfor row in [('00123',10,'=B2*2'),('00124',20,'=B3*2'),('00125',30,'=B4*2')]: s.append(row)\ns.conditional_formatting.add('B2:B4',CellIsRule(operator='greaterThan',formula=['15'],fill=PatternFill('solid',fgColor='FF0000')))\nt=w.create_sheet('汇总'); t['A1']='总计'; t['A2']="=SUM('明细'!C2:C4)"; c=BarChart(); c.add_data(Reference(s,min_col=2,min_row=1,max_row=4),titles_from_data=True); c.width=12;c.height=7;t.add_chart(c,'A4')\nfor x,area in [(s,'A1:C4'),(t,'A1:G20')]: x.print_area=area;x.sheet_properties.pageSetUpPr.fitToPage=True;x.page_setup.fitToWidth=1;x.page_setup.fitToHeight=1\nw.save('/tmp/work/output/result.xlsx'); r=load_workbook('/tmp/work/output/result.xlsx'); assert r['明细']['A2'].value=='00123'; assert len(r['汇总']._charts)==1; assert len(r['明细'].conditional_formatting)==1`,
  pptx: `from pptx import Presentation\nfrom pptx.chart.data import CategoryChartData\nfrom pptx.enum.chart import XL_CHART_TYPE\nfrom pptx.util import Inches\np=Presentation(); s=p.slides.add_slide(p.slide_layouts[5]);s.shapes.title.text='收入趋势'; d=CategoryChartData(); d.categories=['八月','九月'];d.add_series('收入',[12,20]); chart=s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,Inches(1),Inches(1.5),Inches(7),Inches(4),d).chart\nd=CategoryChartData();d.categories=['八月','九月'];d.add_series('收入',[12,35]);chart.replace_data(d)\np.slides.add_slide(p.slide_layouts[5]);s=p.slides.add_slide(p.slide_layouts[5]);s.shapes.title.text='后续行动';s.notes_slide.notes_text_frame.text='请确认下一步安排';p.save('/tmp/work/output/result.pptx')\nr=Presentation('/tmp/work/output/result.pptx'); assert len(r.slides)==3; assert '请确认' in r.slides[2].notes_slide.notes_text_frame.text; assert list(r.slides[0].shapes[1].chart.series[0].values)==[12,35]`,
};
const suite =
  process.env.ALLRICE_RUN_OFFICE_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('DSH native Office in the real task sandbox', () => {
  for (const [format, script] of Object.entries(cases)) {
    it(`executes native ${format} features and upstream package checks`, async () => {
      const backend = new CloudRunnerBackend(),
        attemptId = randomUUID();
      try {
        const result = await backend.executeOffice(
          CloudCommandInputSchema.parse({
            script,
            outputs: [
              {
                path: `result.${format}`,
                fileName: `result.${format}`,
                format: 'txt',
              },
            ],
            limits: { timeoutMs: 60000, memoryMiB: 512, cpuMillis: 1000 },
          }),
          [],
          {
            attemptId,
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
            maintainLease: async () => true,
          },
        );
        expect(result.reason, result.output).toBe('completed');
        expect(result.output).toContain('"verdict": "pass"');
        expect(result.artifacts).toHaveLength(1);
        expect(
          Buffer.from(result.artifacts[0]!.contentBase64, 'base64')
            .subarray(0, 2)
            .toString(),
        ).toBe('PK');
      } finally {
        await backend.stop(attemptId);
        await backend.cleanup(attemptId);
      }
    }, 70000);
  }
  it('does not publish a corrupt document even when Python exits successfully', async () => {
    const backend = new CloudRunnerBackend(),
      attemptId = randomUUID();
    try {
      const result = await backend.executeOffice(
        CloudCommandInputSchema.parse({
          script:
            "open('/tmp/work/output/result.xlsx','wb').write(b'not an Office file')",
          outputs: [
            { path: 'result.xlsx', fileName: 'result.xlsx', format: 'txt' },
          ],
        }),
        [],
        {
          attemptId,
          deadlineAt: new Date(Date.now() + 30000).toISOString(),
          maintainLease: async () => true,
        },
      );
      expect(result.reason).toBe('failed');
      expect(result.artifacts).toEqual([]);
      expect(result.output).toContain('"verdict": "fail"');
    } finally {
      await backend.stop(attemptId);
      await backend.cleanup(attemptId);
    }
  }, 40000);
});
