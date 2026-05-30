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
  hubspot,
} from "@hubspot/ui-extensions";

hubspot.extend(({ context }) => <SumbleListBuilder context={context} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const NEW_LIST = "__new__";

const SumbleListBuilder = () => {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [hubspotLists, setHubspotLists] = useState([]);
  const [sumbleLists, setSumbleLists] = useState([]);

  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [newListName, setNewListName] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState(null);

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
        getJson("/api/sumble-lists", { method: "GET" }),
      ]);
      setHubspotLists(hs.lists || []);
      setSumbleLists(sb.lists || []);
    } catch (err) {
      console.error("[ListBuilder] load error:", err);
      setLoadError(err.message || "Couldn't load lists.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLists();
  }, []);

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      const body = { hubspotListId: sourceId };
      if (targetId === NEW_LIST) body.newListName = newListName.trim();
      else body.sumbleListId = targetId;
      const json = await getJson("/api/push-to-sumble-list", { method: "POST", body });
      // Deep-link to Organization search FILTERED to this list (the useful view),
      // not the raw list page. Falls back to the API list url if no id.
      const listId = json.listId || (targetId !== NEW_LIST ? targetId : null);
      json._listUrl = listId
        ? `https://sumble.com/orgs?sort=Sumble+score&desc=1&lists=${listId}`
        : json.listUrl || null;
      setResult(json);
      // A new list was created → refresh the dropdown.
      if (targetId === NEW_LIST) await loadLists();
    } catch (err) {
      console.error("[ListBuilder] submit error:", err);
      setSubmitError(err.message || "Failed to add companies.");
    } finally {
      setSubmitting(false);
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

  return (
    <Flex direction="column" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Add a HubSpot list to Sumble</Heading>
        <Text variant="microcopy">
          Pick a HubSpot company list and push every company into a Sumble organization list, so reps
          can dig into the segment in Sumble. Companies are matched by their synced Sumble slug — any
          without one are skipped. No Sumble credits are used to create or add to a list.
        </Text>
      </Flex>

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
              Added <Text inline format={{ fontWeight: "bold" }}>{result.added}</Text> of{" "}
              {result.totalCompanies} companies
              {result.listName ? <> to <Text inline format={{ fontWeight: "bold" }}>{result.listName}</Text></> : null}.
              {result.skippedNoSlug > 0
                ? ` ${result.skippedNoSlug} skipped (no Sumble match).`
                : ""}
              {result.failed > 0 ? ` ${result.failed} failed.` : ""}
            </Text>
            {result._listUrl ? (
              <Link href={{ url: result._listUrl, external: true }}>
                Open this list in Sumble (org search, sorted by Sumble score)
              </Link>
            ) : null}
          </Flex>
        </Alert>
      ) : null}
    </Flex>
  );
};
