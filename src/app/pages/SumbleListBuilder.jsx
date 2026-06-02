import React, { useState, useEffect } from "react";
import {
  Text,
  Heading,
  Flex,
  Tile,
  Divider,
  Select,
  Input,
  Button,
  LoadingButton,
  Link,
  Alert,
  LoadingSpinner,
  Tabs,
  Tab,
  Statistics,
  StatisticsItem,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  EmptyState,
  hubspot,
} from "@hubspot/ui-extensions";

hubspot.extend(({ context }) => <SumbleListBuilder context={context} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const NEW_LIST = "__new__";

const SumbleListBuilder = ({ context }) => {
  const portalId = context?.portal?.id;

  // ----- shared list data (Build + Segment tabs) -----
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [hubspotLists, setHubspotLists] = useState([]);
  const [sumbleLists, setSumbleLists] = useState([]);
  const [creditsRemaining, setCreditsRemaining] = useState(null);

  // ----- Build tab -----
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [newListName, setNewListName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState(null);

  // ----- Segment report tab -----
  const [segListId, setSegListId] = useState("");
  const [segLoading, setSegLoading] = useState(false);
  const [segReport, setSegReport] = useState(null);
  const [segError, setSegError] = useState(null);

  // ----- Recent activity tab -----
  const [logLoading, setLogLoading] = useState(true);
  const [logEntries, setLogEntries] = useState([]);
  const [logError, setLogError] = useState(null);

  const getJson = async (path, options) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, options);
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Request failed");
    return json;
  };

  const loadLists = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [hs, sb] = await Promise.all([
        getJson("/api/hubspot-company-lists", { method: "GET" }),
        getJson(`/api/sumble-lists?portalId=${encodeURIComponent(portalId || "")}`, { method: "GET" }),
      ]);
      setHubspotLists(hs.lists || []);
      setSumbleLists(sb.lists || []);
      if (sb.creditsRemaining != null) setCreditsRemaining(sb.creditsRemaining);
    } catch (err) {
      console.error("[ListBuilder] load error:", err);
      setLoadError(err.message || "Couldn't load lists.");
    } finally {
      setLoading(false);
    }
  };

  const loadLog = async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      const json = await getJson(
        `/api/push-log?portalId=${encodeURIComponent(portalId || "")}`,
        { method: "GET" }
      );
      setLogEntries(json.entries || []);
    } catch (err) {
      console.error("[ListBuilder] log error:", err);
      setLogError(err.message || "Couldn't load recent activity.");
    } finally {
      setLogLoading(false);
    }
  };

  useEffect(() => {
    loadLists();
    loadLog();
  }, []);

  // Helpers to resolve readable names for the push log.
  const hubspotListName = (id) => hubspotLists.find((l) => String(l.id) === String(id))?.name || null;
  const sumbleListName = (id) => sumbleLists.find((l) => String(l.id) === String(id))?.name || null;

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      const body = {
        hubspotListId: sourceId,
        hubspotListName: hubspotListName(sourceId),
        portalId,
      };
      if (targetId === NEW_LIST) body.newListName = newListName.trim();
      else {
        body.sumbleListId = targetId;
        body.sumbleListName = sumbleListName(targetId);
      }
      const json = await getJson("/api/push-to-sumble-list", { method: "POST", body });
      // Deep-link to Organization search FILTERED to this list (the useful view),
      // not the raw list page. Falls back to the API list url if no id.
      const listId = json.listId || (targetId !== NEW_LIST ? targetId : null);
      json._listUrl = listId
        ? `https://sumble.com/orgs?sort=Sumble+score&desc=1&lists=${listId}`
        : json.listUrl || null;
      setResult(json);
      // Refresh the activity log so the new push shows up, and refresh the
      // dropdown if a new list was created.
      await loadLog();
      if (targetId === NEW_LIST) await loadLists();
    } catch (err) {
      console.error("[ListBuilder] submit error:", err);
      setSubmitError(err.message || "Failed to add companies.");
    } finally {
      setSubmitting(false);
    }
  };

  const runSegmentReport = async () => {
    setSegLoading(true);
    setSegError(null);
    setSegReport(null);
    try {
      const json = await getJson("/api/segment-report", {
        method: "POST",
        body: { hubspotListId: segListId, portalId },
      });
      setSegReport(json);
    } catch (err) {
      console.error("[ListBuilder] segment report error:", err);
      setSegError(err.message || "Couldn't build the segment report.");
    } finally {
      setSegLoading(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center" gap="small">
        <LoadingSpinner label="Loading your HubSpot and Sumble lists..." />
      </Flex>
    );
  }
  if (loadError) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Couldn't load lists" variant="error">{loadError}</Alert>
        <Button onClick={loadLists} variant="secondary">Retry</Button>
      </Flex>
    );
  }

  const sourceOptions = hubspotLists.map((l) => ({
    label: l.size != null ? `${l.name} (${l.size})` : l.name,
    value: String(l.id),
  }));
  const targetOptions = [
    ...sumbleLists.map((l) => ({
      label: l.count != null ? `${l.name} (${l.count})` : l.name,
      value: String(l.id),
    })),
    { label: "➕ Create a new list…", value: NEW_LIST },
  ];

  const creatingNew = targetId === NEW_LIST;
  const canSubmit =
    !!sourceId && !!targetId && (!creatingNew || newListName.trim().length > 0) && !submitting;

  // ---------------------------------------------------------------- Build tab
  const buildTab = (
    <Flex direction="column" gap="medium">
      <Text variant="microcopy">
        Pick a HubSpot company list and push every company into a Sumble organization list, so reps
        can dig into the segment in Sumble. Companies are matched by their synced Sumble slug — any
        without one are skipped. No Sumble credits are used to create or add to a list.
      </Text>

      <Tile>
        <Flex direction="column" gap="medium">
          <Select
            label="1 · HubSpot company list (source)"
            name="source"
            required={true}
            placeholder={sourceOptions.length ? "Choose a list…" : "No company lists found"}
            options={sourceOptions}
            value={sourceId}
            onChange={(v) => setSourceId(v)}
          />

          <Select
            label="2 · Sumble list (target)"
            name="target"
            required={true}
            placeholder="Choose or create…"
            options={targetOptions}
            value={targetId}
            onChange={(v) => setTargetId(v)}
          />

          {creatingNew ? (
            <Input
              label="New Sumble list name"
              name="newListName"
              required={true}
              value={newListName}
              onInput={(v) => setNewListName(v)}
              placeholder="e.g. Q3 New Business Targets"
            />
          ) : null}

          <Divider />
          <Flex direction="row" gap="small" align="center">
            <LoadingButton loading={submitting} disabled={!canSubmit} onClick={submit} variant="primary">
              Add companies to Sumble list
            </LoadingButton>
            <Button onClick={loadLists} variant="secondary" disabled={submitting}>Refresh lists</Button>
          </Flex>
        </Flex>
      </Tile>

      {submitError ? <Alert title="Failed to add companies" variant="error">{submitError}</Alert> : null}

      {result ? (
        <Alert title="Done" variant="success">
          <Flex direction="column" gap="extra-small">
            <Text>
              Sent <Text inline format={{ fontWeight: "bold" }}>{result.withSlug}</Text> of{" "}
              {result.totalCompanies} companies
              {result.listName ? <> to <Text inline format={{ fontWeight: "bold" }}>{result.listName}</Text></> : null}.
              {result.skippedNoSlug > 0
                ? ` ${result.skippedNoSlug} had no Sumble match and were skipped.`
                : ""}
              {result.failed > 0 ? ` ${result.failed} failed.` : ""}
            </Text>
            <Text variant="microcopy">
              Sumble de-duplicates automatically — any companies already on the list aren't added twice.
            </Text>
            {result._listUrl ? (
              <Link href={{ url: result._listUrl, external: true }}>Open accounts in Sumble</Link>
            ) : null}
          </Flex>
        </Alert>
      ) : null}
    </Flex>
  );

  // ------------------------------------------------------- Segment report tab
  const segmentTab = (
    <Flex direction="column" gap="medium">
      <Text variant="microcopy">
        Aggregate the synced Sumble fields across a HubSpot company list — sellable-seat totals and
        Sumble match coverage. Reads only synced HubSpot properties, so it uses no Sumble credits.
      </Text>

      <Tile>
        <Flex direction="column" gap="medium">
          <Select
            label="HubSpot company list"
            name="segSource"
            required={true}
            placeholder={sourceOptions.length ? "Choose a list…" : "No company lists found"}
            options={sourceOptions}
            value={segListId}
            onChange={(v) => setSegListId(v)}
          />
          <Flex direction="row" gap="small" align="center">
            <LoadingButton
              loading={segLoading}
              disabled={!segListId || segLoading}
              onClick={runSegmentReport}
              variant="primary"
            >
              Run report
            </LoadingButton>
          </Flex>
        </Flex>
      </Tile>

      {segError ? <Alert title="Couldn't build the report" variant="error">{segError}</Alert> : null}

      {segReport ? (
        <Tile>
          <Flex direction="column" gap="medium">
            <Statistics>
              <StatisticsItem label="Companies" number={segReport.totalCompanies}>
                <Text>{segReport.matched} matched to Sumble ({segReport.matchRate}%)</Text>
              </StatisticsItem>
              <StatisticsItem label="IC SDR seats" number={segReport.icSdrTotal} />
              <StatisticsItem label="IC AE seats" number={segReport.icAeTotal} />
              <StatisticsItem label="IC sales (total)" number={segReport.icSalesTotal} />
              <StatisticsItem label="Avg account fit" number={segReport.avgFit ?? "—"} />
              <StatisticsItem label="Hiring SDRs (1mo)" number={segReport.hiringSdrCompanies} />
            </Statistics>

            <Divider />

            <Flex direction="column" gap="extra-small">
              <Text format={{ fontWeight: "bold" }}>Sales segment distribution</Text>
              <Text variant="microcopy">
                COMM {segReport.segments?.COMM ?? 0} · Mid-Market {segReport.segments?.["Mid-Market"] ?? 0}
                {" "}· Enterprise {segReport.segments?.Enterprise ?? 0} · Unknown {segReport.segments?.Unknown ?? 0}
              </Text>
            </Flex>

            {segReport.capped ? (
              <Alert title="List truncated" variant="warning">
                This list is large — only the first 1,000 companies were aggregated.
              </Alert>
            ) : null}
          </Flex>
        </Tile>
      ) : null}
    </Flex>
  );

  // ------------------------------------------------------- Recent activity tab
  const activityTab = (
    <Flex direction="column" gap="medium">
      <Flex direction="row" gap="small" align="center" justify="between">
        <Text variant="microcopy">The 20 most recent list pushes for this portal.</Text>
        <Button onClick={loadLog} variant="secondary" disabled={logLoading} size="extra-small">
          Refresh
        </Button>
      </Flex>

      {logError ? <Alert title="Couldn't load activity" variant="error">{logError}</Alert> : null}

      {logLoading ? (
        <LoadingSpinner label="Loading recent activity..." />
      ) : logEntries.length === 0 ? (
        <EmptyState title="No pushes yet" layout="vertical" imageName="automatedTesting">
          <Text>Push a HubSpot list to Sumble from the “Build list” tab and it’ll show up here.</Text>
        </EmptyState>
      ) : (
        <Table bordered={true} density="condensed">
          <TableHead>
            <TableRow>
              <TableHeader>When</TableHeader>
              <TableHeader>HubSpot list</TableHeader>
              <TableHeader>Sumble list</TableHeader>
              <TableHeader align="right">Added / Total</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {logEntries.map((e, i) => (
              <TableRow key={i}>
                <TableCell>{formatWhen(e.created_at)}</TableCell>
                <TableCell>{e.hubspot_list || "—"}</TableCell>
                <TableCell>{e.sumble_list || "—"}</TableCell>
                <TableCell align="right">
                  {e.added ?? 0} / {e.total ?? 0}
                  {e.skipped ? ` (${e.skipped} skipped)` : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Flex>
  );

  return (
    <Flex direction="column" gap="medium">
      <Flex direction="row" justify="between" align="center">
        <Heading>Sumble enrichment</Heading>
        {creditsRemaining != null ? (
          <Text variant="microcopy">
            <Text inline format={{ fontWeight: "bold" }}>{creditsRemaining.toLocaleString()}</Text> Sumble credits remaining
          </Text>
        ) : null}
      </Flex>

      <Tabs defaultSelected="build">
        <Tab tabId="build" title="Build list">{buildTab}</Tab>
        <Tab tabId="segment" title="Segment report">{segmentTab}</Tab>
        <Tab tabId="activity" title="Recent activity">{activityTab}</Tab>
      </Tabs>
    </Flex>
  );
};

// Render an ISO timestamp as a short, locale-free "YYYY-MM-DD HH:MM" string.
function formatWhen(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return String(iso).slice(0, 16).replace("T", " ");
  }
}
