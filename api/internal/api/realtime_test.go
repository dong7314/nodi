package api

import (
	"encoding/json"
	"testing"
)

func realtimeBlocksByID(t *testing.T, value json.RawMessage) map[string]map[string]any {
	t.Helper()
	var blocks []map[string]any
	if err := json.Unmarshal(value, &blocks); err != nil {
		t.Fatalf("decode merged blocks: %v", err)
	}
	result := make(map[string]map[string]any, len(blocks))
	for _, block := range blocks {
		result[block["id"].(string)] = block
	}
	return result
}

func TestMergeRealtimeBlocksPreservesConcurrentBlockEdits(t *testing.T) {
	base := json.RawMessage(`[
		{"id":"a","type":"paragraph","content":"A"},
		{"id":"b","type":"paragraph","content":"B"}
	]`)
	fromA := json.RawMessage(`[
		{"id":"a","type":"paragraph","content":"A edited"},
		{"id":"b","type":"paragraph","content":"B"}
	]`)
	mergedA, err := mergeRealtimeBlocks(base, fromA, []string{"a"}, nil, false)
	if err != nil {
		t.Fatalf("merge A: %v", err)
	}

	// B started from the same base revision, but edited another block. Its
	// stale copy of A must not overwrite the canonical edit from A.
	fromB := json.RawMessage(`[
		{"id":"a","type":"paragraph","content":"A"},
		{"id":"b","type":"paragraph","content":"B edited"}
	]`)
	mergedB, err := mergeRealtimeBlocks(mergedA, fromB, []string{"b"}, nil, false)
	if err != nil {
		t.Fatalf("merge B: %v", err)
	}
	blocks := realtimeBlocksByID(t, mergedB)
	if blocks["a"]["content"] != "A edited" || blocks["b"]["content"] != "B edited" {
		t.Fatalf("concurrent edits were not preserved: %s", mergedB)
	}
}

func TestMergeRealtimeBlocksKeepsConcurrentInsertDuringReorder(t *testing.T) {
	current := json.RawMessage(`[
		{"id":"a","type":"paragraph","content":"A"},
		{"id":"b","type":"paragraph","content":"B"},
		{"id":"remote","type":"paragraph","content":"remote insert"}
	]`)
	incoming := json.RawMessage(`[
		{"id":"a","type":"paragraph","content":"A"},
		{"id":"local","type":"paragraph","content":"local insert"},
		{"id":"b","type":"paragraph","content":"B"}
	]`)
	merged, err := mergeRealtimeBlocks(current, incoming, []string{"local"}, nil, true)
	if err != nil {
		t.Fatalf("merge structural patch: %v", err)
	}
	_, ids, err := decodeRealtimeBlocks(merged)
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	want := []string{"a", "local", "b", "remote"}
	if len(ids) != len(want) {
		t.Fatalf("unexpected ids: %v", ids)
	}
	for index := range want {
		if ids[index] != want[index] {
			t.Fatalf("unexpected order: got %v want %v", ids, want)
		}
	}
}

func TestMergeRealtimeBlocksDeletesOnlyExplicitBlocks(t *testing.T) {
	current := json.RawMessage(`[
		{"id":"a","type":"paragraph","content":"A"},
		{"id":"b","type":"paragraph","content":"B"},
		{"id":"c","type":"paragraph","content":"C"}
	]`)
	incoming := json.RawMessage(`[
		{"id":"a","type":"paragraph","content":"A"},
		{"id":"c","type":"paragraph","content":"C"}
	]`)
	merged, err := mergeRealtimeBlocks(current, incoming, nil, []string{"b"}, true)
	if err != nil {
		t.Fatalf("merge deletion: %v", err)
	}
	_, ids, err := decodeRealtimeBlocks(merged)
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "c" {
		t.Fatalf("unexpected deletion result: %v", ids)
	}
}

func TestMergeRealtimeBlocksNormalizesLegacyBlocksWithoutIDs(t *testing.T) {
	legacy := json.RawMessage(`[
		{"type":"paragraph","content":""}
	]`)
	incoming := json.RawMessage(`[
		{"id":"generated-id","type":"paragraph","content":[{"type":"text","text":"test","styles":{}}]}
	]`)

	merged, err := mergeRealtimeBlocks(legacy, incoming, []string{"generated-id"}, nil, false)
	if err != nil {
		t.Fatalf("normalize legacy blocks: %v", err)
	}
	blocks := realtimeBlocksByID(t, merged)
	block := blocks["generated-id"]
	if block == nil {
		t.Fatalf("normalized block ID is missing: %s", merged)
	}
	content, ok := block["content"].([]any)
	if !ok || len(content) != 1 || content[0].(map[string]any)["text"] != "test" {
		t.Fatalf("normalized content was not preserved: %s", merged)
	}
}
