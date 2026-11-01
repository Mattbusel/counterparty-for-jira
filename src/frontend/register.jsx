import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, DonutChart, DynamicTable, Heading, Inline, Link, LoadingButton, Lozenge, SectionMessage, Spinner,
  Stack, Text, xcss,
} from '@forge/react';
import { invoke, router } from '@forge/bridge';

const VERDICT_LOZENGE = { CLEAR: 'success', REVIEW: 'moved', BLOCK: 'removed' };
const tileStyle = xcss({ padding: 'space.200', borderRadius: 'border.radius', backgroundColor: 'color.background.neutral', minWidth: '140px' });

const Tile = ({ label, value }) => (
  <Box xcss={tileStyle}>
    <Stack space="space.050">
      <Text>{label}</Text>
      <Heading size="large">{String(value)}</Heading>
    </Stack>
  </Box>
);

const App = () => {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = () => invoke('getRegister').then(d => setRows(d.rows)).catch(e => setMessage({ appearance: 'error', text: e.message }));
  useEffect(() => { load(); }, []);

  const rescreen = async () => {
    setBusy(true);
    try {
      const { queued } = await invoke('rescreenAll');
      setMessage({ appearance: 'information', text: `Rescreening ${queued} counterparties against today's lists. Changed verdicts get a comment on their work item.` });
    } catch (e) {
      setMessage({ appearance: 'error', text: e.message });
    }
    setBusy(false);
  };

  if (!rows) return <Spinner label="Loading register" />;
  const results = rows.filter(r => r.result);
  const count = v => results.filter(r => r.result.verdict === v).length;
  const chart = ['CLEAR', 'REVIEW', 'BLOCK'].map(v => ({ verdict: v, count: count(v) })).filter(d => d.count);

  const head = {
    cells: [
      { key: 'issue', content: 'Work item', isSortable: true },
      { key: 'vendor', content: 'Counterparty', isSortable: true },
      { key: 'verdict', content: 'Verdict', isSortable: true },
      { key: 'why', content: 'Why' },
      { key: 'checked', content: 'Checked', isSortable: true },
      { key: 'status', content: 'Status' },
    ],
  };
  const tableRows = results.map(r => ({
    key: r.key,
    cells: [
      { key: 'issue', content: <Link href={`/browse/${r.key}`} onClick={() => router.navigate(`/browse/${r.key}`)}>{r.key}</Link> },
      { key: 'vendor', content: r.result.legalName && r.result.legalName.toUpperCase() !== String(r.result.vendor).toUpperCase() ? `${r.result.vendor} (${r.result.legalName})` : r.result.vendor },
      { key: 'verdict', content: <Lozenge appearance={VERDICT_LOZENGE[r.result.verdict] || 'default'}>{r.result.verdict}</Lozenge> },
      { key: 'why', content: (r.result.reasons || [])[0] || '' },
      { key: 'checked', content: String(r.result.checkedAt || '').slice(0, 10) },
      { key: 'status', content: r.status },
    ],
  }));

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Text>Every vendor, supplier and partner screened in this site, with the latest verdict. Open counterparties are rescreened daily against the newest OFAC and HHS-OIG lists. Search them in JQL with counterpartyVerdict = BLOCK.</Text>
      </Stack>
      <Inline space="space.200" alignBlock="center" shouldWrap>
        <Tile label="Screened" value={results.length} />
        <Tile label="Clear" value={count('CLEAR')} />
        <Tile label="Needs review" value={count('REVIEW')} />
        <Tile label="Blocked" value={count('BLOCK')} />
        {chart.length ? (
          <Box xcss={xcss({ width: '260px' })}>
            <DonutChart
              data={chart} colorAccessor="verdict" labelAccessor="verdict" valueAccessor="count" height={200}
              hideMenu showBorder={false}
              colorPalette={[{ key: 'CLEAR', value: '#22A06B' }, { key: 'REVIEW', value: '#E2B203' }, { key: 'BLOCK', value: '#C9372C' }]}
            />
          </Box>
        ) : null}
      </Inline>
      <Inline space="space.100" alignBlock="center">
        <LoadingButton appearance="primary" isLoading={busy} onClick={rescreen}>Rescreen all now</LoadingButton>
        <LoadingButton onClick={load}>Refresh</LoadingButton>
      </Inline>
      {message ? <SectionMessage appearance={message.appearance}><Text>{message.text}</Text></SectionMessage> : null}
      <DynamicTable head={head} rows={tableRows} rowsPerPage={20} emptyView="No counterparties screened yet. Create a work item titled 'Vendor: Company name' or use the Counterparty check panel." />
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
