/** Hand-counted synthetic reference, independent from the production evaluator. */
export const attendanceAnswer = {
  results: [
    {
      id: 'complete-a',
      status: 'counted',
      present: { count: 4, ids: ['A01', 'A03', 'A04', 'A07'] },
      absent: { count: 3, ids: ['A02', 'A05', 'A06'] },
      total: 7,
    },
    {
      id: 'complete-b',
      status: 'counted',
      present: { count: 2, ids: ['B02', 'B05'] },
      absent: { count: 3, ids: ['B01', 'B03', 'B04'] },
      total: 5,
    },
    { id: 'unknown-status', status: 'needs_information' },
    { id: 'no-roster', status: 'needs_information' },
  ],
};
