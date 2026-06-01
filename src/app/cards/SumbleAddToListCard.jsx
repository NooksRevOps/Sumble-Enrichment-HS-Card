import React, { useState, useEffect } from "react";
import {
  Text,
  Flex,
  Divider,
  Select,
  Input,
  Button,
  LoadingButton,
  Link,
  Alert,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumbleAddToListCard actions={actions} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const NEW_LIST = "__new__";

const listSearchUrl = (listId) =>
  listId ? `https://sumble.com/orgs?sort=Sumble+score&desc=1&lists=${listId}` : null;

const SumbleAddToListCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;

  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState(null);
  const [companyName, setCompanyName] = useState(null);

  const [picking, setPicking] = useState(false);   // list picker revealed
  const [loadingLists, setLoadingLists] = useState(false);
  const [lists, setLists] = useState([]);
  const [listsError, setListsError] = useState(null);

  const [targetId, setTargetId] = useState("");
  const [newListName, setNewListName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const getJson = async (path, options) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, options);
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Request failed");
    return json;
  };

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        const props = await actions.fetchCrmObjectProperties(["sumble_organization_slug", "name"]);
        setSlug(props.sumble_organization_slug || null);
        setCompanyName(props.name || null);
      } catch (err) {
        console.error("[AddToList] load error:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  // Loading the list dropdown costs ~1 credit per existing Sumble list, so it's
  // gated behind this click rather than running on every company view.
  const openPicker = async () => {
    setPicking(true);
    setLoadingLists(true);
    setListsError(null);
    try {
      const json = await getJson("/api/sumble-lists", { method: "GET" });
      setLists(json.lists || []);
    } catch (err) {
      setListsError(err.message || "Couldn't load Sumble lists.");
    } finally {
      setLoadingLists(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const body = { slugs: [slug] };
      if (targetId === NEW_LIST) body.newListName = newListName.trim();
      else body.sumbleListId = targetId;
      const json = await getJson("/api/add-to-sumble-list", { method: "POST", body });
      const listId = json.listId || (targetId !== NEW_LIST ? targetId : null);
      json._url = listSearchUrl(listId);
      // name fallback for existing list
      if (!json.listName) json.listName = lists.find((l) => String(l.id) === String(targetId))?.name || "the list";
      setResult(json);
    } catch (err) {
      setError(err.message || "Failed to add to list.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center"><LoadingSpinner label="Loading..." /></Flex>
    );
  }

  if (!slug) {
    return (
      <Text variant="microcopy">
        This company isn't matched to Sumble yet, so it can't be added to a list.
      </Text>
    );
  }

  // Success state
  if (result) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Added to Sumble list" variant="success">
          Added <Text inline format={{ fontWeight: "bold" }}>{companyName || "this company"}</Text> to{" "}
          <Text inline format={{ fontWeight: "bold" }}>{result.listName}</Text>.
        </Alert>
        {result._url ? (
          <Link href={{ url: result._url, external: true }}>Open accounts in Sumble</Link>
        ) : null}
        <Button
          variant="secondary"
          size="xs"
          onClick={() => { setResult(null); setPicking(true); setTargetId(""); setNewListName(""); }}
        >
          Add to another list
        </Button>
      </Flex>
    );
  }

  if (!picking) {
    return (
      <Flex direction="column" gap="small">
        <Text variant="microcopy">Add this company to a Sumble organization list.</Text>
        <Button variant="primary" onClick={openPicker}>➕ Add to a Sumble list</Button>
      </Flex>
    );
  }

  // Picker
  const creatingNew = targetId === NEW_LIST;
  const canSubmit = !!targetId && (!creatingNew || newListName.trim().length > 0) && !submitting;
  const options = [
    ...lists.map((l) => ({ label: l.count != null ? `${l.name} (${l.count})` : l.name, value: String(l.id) })),
    { label: "➕ Create a new list…", value: NEW_LIST },
  ];

  return (
    <Flex direction="column" gap="small">
      {loadingLists ? (
        <Flex direction="column" align="center"><LoadingSpinner label="Loading your Sumble lists..." /></Flex>
      ) : listsError ? (
        <Flex direction="column" gap="small">
          <Alert title="Couldn't load lists" variant="error">{listsError}</Alert>
          <Button variant="secondary" onClick={openPicker}>Retry</Button>
        </Flex>
      ) : (
        <>
          <Select
            label="Sumble list"
            name="target"
            required={true}
            placeholder="Choose or create…"
            options={options}
            value={targetId}
            onChange={(v) => setTargetId(v)}
          />
          {creatingNew ? (
            <Input
              label="New list name"
              name="newListName"
              required={true}
              value={newListName}
              onInput={(v) => setNewListName(v)}
              placeholder="e.g. Q3 Targets"
            />
          ) : null}
          {error ? <Alert title="Error" variant="error">{error}</Alert> : null}
          <Divider />
          <Flex direction="row" gap="small" align="center">
            <LoadingButton loading={submitting} disabled={!canSubmit} onClick={submit} variant="primary">
              Add to list
            </LoadingButton>
            <Button variant="secondary" disabled={submitting} onClick={() => setPicking(false)}>Cancel</Button>
          </Flex>
        </>
      )}
    </Flex>
  );
};
