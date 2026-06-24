import React, { useState, useEffect } from "react";
import {
  Text,
  Flex,
  Tile,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
  ProgressBar,
  Button,
  Panel,
  PanelBody,
  PanelSection,
  Link,
  Alert,
  EmptyState,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumbleScoreBreakdownPanelCard actions={actions} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const DEFAULT_VISIBLE = 6; // signals shown on the card; the rest live in the panel

// Mirror AccountBot's raw-value formatting so the card reads the same as Slack /
// the scoring web app.
function fmtRaw(r, isUsd, isCount) {
  const n = Number(r);
  if (Number.isNaN(n)) return String(r);
  if (isUsd) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (isCount) return String(Math.round(n));
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (n === Math.trunc(n)) return String(Math.trunc(n));
  return n.toFixed(2).replace(/\.?0+$/, "");
}

const fmtPct = (v) => `${Math.round((Number(v) || 0) * 10) / 10}%`;
const fmtPts = (v) => `${(Number(v) || 0).toFixed(1)} pts`;

const ext = (url) => {
  if (!url) return null;
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return { url: full, external: true };
};

const SignalTable = ({ rows, maxContrib }) => (
  <Table bordered density="condensed">
    <TableHead>
      <TableRow>
        <TableHeader width={200}>Signal</TableHeader>
        <TableHeader width="min" align="right">Raw</TableHeader>
        <TableHeader width="min" align="right">Weight</TableHeader>
        <TableHeader width={170}>Contribution</TableHeader>
      </TableRow>
    </TableHead>
    <TableBody>
      {rows.map((s, i) => (
        <TableRow key={i}>
          <TableCell>
            {ext(s.link) ? <Link href={ext(s.link)}>{s.label}</Link> : <Text>{s.label}</Text>}
          </TableCell>
          <TableCell align="right">
            <Text>{fmtRaw(s.raw, s.is_usd, s.is_count)}</Text>
          </TableCell>
          <TableCell align="right">
            <Text>{fmtPct(s.weight_pct)}</Text>
          </TableCell>
          <TableCell>
            <ProgressBar
              variant="success"
              value={Number(s.contribution) || 0}
              maxValue={maxContrib}
              valueDescription={fmtPts(s.contribution)}
            />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const SumbleScoreBreakdownPanelCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;
  const portalId = context?.portal?.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bd, setBd] = useState(null);

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        setError(null);
        const resp = await hubspot.fetch(`${BACKEND_URL}/api/score-breakdown`, {
          method: "POST",
          body: { companyId, portalId },
        });
        const json = await resp.json();
        if (json.status !== "success") throw new Error(json.message || "Backend error");
        setBd(json.breakdown);
      } catch (err) {
        console.error("[SumbleScoreBreakdownPanel] load error:", err);
        setError(err.message || "Couldn't load the score breakdown.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  if (loading) {
    return (
      <Flex direction="column" align="center">
        <LoadingSpinner label="Loading score breakdown..." />
      </Flex>
    );
  }
  if (error) return <Alert title="Error" variant="error">{error}</Alert>;

  if (!bd) {
    return (
      <EmptyState title="No score breakdown yet" imageName="building" layout="vertical">
        <Text>
          This account isn't in the latest scoring export yet — either it was just added to HubSpot
          or it hasn't been scored. The breakdown refreshes daily and will appear once it's scored.
        </Text>
      </EmptyState>
    );
  }

  const signals = Array.isArray(bd.signals) ? bd.signals : [];
  const maxContrib = Math.max(...signals.map((s) => Number(s.contribution) || 0), 0.01);

  return (
    <Tile>
      <Flex direction="column" gap="small">
        <Text variant="microcopy">
          Signals ranked by the points they add to the score. Bar length is proportional to each
          signal's contribution.
        </Text>

        {signals.length === 0 ? (
          <Text format={{ italic: true }}>
            {bd.tier === "Low/No Signal"
              ? "Low/No Signal — there isn't enough signal coverage to score this account yet."
              : "No scored signals contributed to this account's score."}
          </Text>
        ) : (
          <Flex direction="column" gap="small">
            <SignalTable rows={signals.slice(0, DEFAULT_VISIBLE)} maxContrib={maxContrib} />
            {signals.length > DEFAULT_VISIBLE ? (
              <Button
                variant="secondary"
                overlay={
                  <Panel id="sumble-score-breakdown-panel" title="Score breakdown — all signals" width="sm">
                    <PanelBody>
                      <PanelSection>
                        <SignalTable rows={signals} maxContrib={maxContrib} />
                      </PanelSection>
                    </PanelBody>
                  </Panel>
                }
              >
                {`View all ${signals.length} signals`}
              </Button>
            ) : null}
          </Flex>
        )}
      </Flex>
    </Tile>
  );
};
