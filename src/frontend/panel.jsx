import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Button, DynamicTable, Heading, Inline, Label, Link, LoadingButton, Lozenge, SectionMessage,
  Spinner, Stack, Strong, Text, Textfield, xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// Colors and words for each verdict and each per-source result.
const VERDICT = {
  CLEAR: { appearance: 'success', title: 'CLEAR: clear to proceed' },
  REVIEW: { appearance: 'warning', title: 'REVIEW: a person must look before proceeding' },
  BLOCK: { appearance: 'error', title: 'BLOCK: do not proceed' },
};
const RESULT = {
  block: { text: 'Match', appearance: 'removed' },
  review: { text: 'Review', appearance: 'moved' },
  info: { text: 'Info', appearance: 'default' },
  none: { text: 'Clear', appearance: 'success' },
};

const growStyle = xcss({ flexGrow: 1 });
const cardStyle = xcss({ padding: 'space.150', borderRadius: 'border.radius', backgroundColor: 'color.background.neutral' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function Evidence({ report }) {
  const items = [];
  for (const s of report.sources) {
    const flagged = s.severity === 'block' || s.severity === 'review';
    for (const f of s.findings) {
      if (!f.url || !(flagged || f.flag)) continue;
      items.push({ s, f });
    }
  }
  if (!items.length) return null;
  return (
    <Stack space="space.100">
      <Heading size="xsmall">Evidence</Heading>
      {items.slice(0, 8).map(({ s, f }, i) => (
        <Box key={i} xcss={cardStyle}>
          <Stack space="space.050">
            <Inline space="space.100" alignBlock="center">
              <Lozenge appearance={RESULT[s.severity] ? RESULT[s.severity].appearance : 'default'}>{s.label}</Lozenge>
              <Link href={f.url} openNewTab>{f.title}</Link>
              {f.score ? <Text>{Math.round(f.score * 100)}% name match</Text> : null}
            </Inline>
            {f.detail ? <Text>{String(f.detail).slice(0, 300)}</Text> : null}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function Report({ report }) {
  const v = VERDICT[report.verdict];
  const head = {
    cells: [
      { key: 'source', content: 'Source' },
      { key: 'result', content: 'Result' },
      { key: 'summary', content: 'What we found' },
      { key: 'version', content: 'Data version' },
    ],
  };
  const rows = report.sources.map(s => ({
    key: s.source,
    cells: [
      { key: 'source', content: <Link href={s.sourceUrl} openNewTab>{s.label}</Link> },
      { key: 'result', content: <Lozenge appearance={(RESULT[s.severity] || RESULT.info).appearance}>{(RESULT[s.severity] || RESULT.info).text}</Lozenge> },
      { key: 'summary', content: s.headline },
      { key: 'version', content: s.asOf },
    ],
  }));
  return (
    <Stack space="space.200">
      <SectionMessage appearance={v.appearance} title={v.title}>
        <Stack space="space.050">
          {report.reasons.map((r, i) => <Text key={i}>{r}</Text>)}
        </Stack>
      </SectionMessage>
      {report.identity ? (
        <Text>
          Registered as <Link href={`https://search.gleif.org/#/record/${report.identity.lei}`} openNewTab>{report.identity.name}</Link> ({report.identity.jurisdiction}, LEI {report.identity.lei})
        </Text>
      ) : null}
      <DynamicTable head={head} rows={rows} />
      <Evidence report={report} />
    </Stack>
  );
}

const App = () => {
  const [state, setState] = useState(null);
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async () => {
    const s = await invoke('getPanelState');
    setState(s);
    setName(prev => prev || s.suggestedName || '');
    return s;
  };

  useEffect(() => { load().catch(e => setMessage({ appearance: 'error', text: e.message })); }, []);

  const run = async () => {
    setRunning(true); setMessage(null);
    try {
      const { jobId } = await invoke('startScreen', { name });
      // Poll the background job; a full screen usually takes a few seconds.
      for (let i = 0; i < 90; i++) {
        await sleep(i < 5 ? 1500 : 2500);
        const job = await invoke('getJob', { jobId });
        if (job.status === 'done') { await load(); break; }
        if (job.status === 'error') { setMessage({ appearance: 'error', text: job.error }); break; }
      }
    } catch (e) {
      setMessage({ appearance: 'error', text: e.message });
    }
    setRunning(false);
  };

  const post = async () => {
    setPosting(true);
    try {
      await invoke('postReceipt');
      setMessage({ appearance: 'success', text: 'Receipt posted as a comment on this work item.' });
    } catch (e) {
      setMessage({ appearance: 'error', text: e.message });
    }
    setPosting(false);
  };

  if (!state) return <Spinner label="Loading counterparty check" />;
  const report = state.report;

  return (
    <Stack space="space.200">
      <Stack space="space.050">
        <Label labelFor="cp-name">Counterparty to screen</Label>
        <Inline space="space.100" alignBlock="center">
          <Box xcss={growStyle}>
            <Textfield id="cp-name" value={name} placeholder="Company or person, e.g. Acme Medical Supply Inc." onChange={e => setName(e.target.value)} />
          </Box>
          <LoadingButton appearance="primary" isLoading={running} isDisabled={!name.trim()} onClick={run}>
            {report ? 'Run again' : 'Run check'}
          </LoadingButton>
        </Inline>
        {running ? <Text>Checking 7 public sources: OFAC, HHS-OIG, GLEIF, SEC, USAspending, FDA, CFPB.</Text> : null}
      </Stack>
      {message ? <SectionMessage appearance={message.appearance}><Text>{message.text}</Text></SectionMessage> : null}
      {report ? <Report report={report} /> : (
        <Text>No check on this work item yet. Type the vendor, supplier or partner name and run a check.</Text>
      )}
      {report ? (
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <LoadingButton isLoading={posting} onClick={post}>Post receipt as comment</LoadingButton>
          <Text>
            <Strong>Receipt {report.receiptId}</Strong>, checked {report.checkedAt.replace('T', ' ').slice(0, 16)} UTC for "{report.query}"
          </Text>
        </Inline>
      ) : null}
      {state.history && state.history.length > 1 ? (
        <Stack space="space.050">
          <Heading size="xxsmall">Earlier checks</Heading>
          {state.history.slice(1, 6).map((h, i) => (
            <Text key={i}>{h.checkedAt.slice(0, 10)}: {h.verdict} for "{h.vendor}" (receipt {h.receiptId})</Text>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
