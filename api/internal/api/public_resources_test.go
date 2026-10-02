package api

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPublicBlocksPreserveContentAndRedactPrivateReferences(t *testing.T) {
	input := json.RawMessage(`[{"id":"outer","type":"paragraph","content":"Keep this text","custom":9007199254740993,"children":[{"type":"childPage","props":{"pageId":"private-id","title":"Private title"}},{"type":"childPage","props":{"pageId":"public-id","title":"Outdated title"}}]}]`)
	before := string(input)
	output, err := publicPageBlocks(input, map[string]string{"public-id": "Current public title"})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-id", "Private title", "Outdated title"} {
		if strings.Contains(string(output), private) {
			t.Fatalf("public blocks contain %q", private)
		}
	}
	for _, preserved := range []string{"Keep this text", "9007199254740993", "public-id", "Current public title", "비공개 페이지"} {
		if !strings.Contains(string(output), preserved) {
			t.Fatalf("public blocks lost %q", preserved)
		}
	}
	if string(input) != before {
		t.Fatal("projection changed the original document")
	}
}

func TestPublicDatabaseKeepsActiveStateWithoutTrash(t *testing.T) {
	input := json.RawMessage(`{"name":"Schedule","records":[{"id":"active"}],"trash":[{"id":"deleted"}],"properties":[{"id":"date","type":"date"}],"views":[{"id":"timeline","type":"timeline"}],"activeViewId":"timeline","custom":9007199254740993}`)
	output, err := publicDatabaseState(input)
	if err != nil {
		t.Fatal(err)
	}
	expected := json.RawMessage(`{"name":"Schedule","records":[{"id":"active"}],"trash":[],"properties":[{"id":"date","type":"date"}],"views":[{"id":"timeline","type":"timeline"}],"activeViewId":"timeline","custom":9007199254740993}`)
	if !jsonValuesEqual(output, expected) || !strings.Contains(string(output), "9007199254740993") {
		t.Fatalf("public state changed visible fields: %s", output)
	}
	if !strings.Contains(string(input), "deleted") {
		t.Fatal("projection removed source trash")
	}
}

func TestPublicResourceIDsIncludeNestedAndLegacyBlocks(t *testing.T) {
	refs, err := pageResourceIDs(json.RawMessage(`[{"type":"paragraph","children":[{"type":"database","props":{"databaseId":"explicit"}},{"id":"legacy","type":"database","props":{}},{"type":"childPage","props":{"pageId":"child"}}]}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(refs.databases) != 2 || refs.databases[0] != "explicit" || refs.databases[1] != "database-legacy" || len(refs.childPages) != 1 || refs.childPages[0] != "child" {
		t.Fatalf("unexpected references: %+v", refs)
	}
	if _, err := pageResourceIDs(json.RawMessage(`[{"children":{}}]`)); err == nil {
		t.Fatal("malformed resource tree was accepted")
	}
}
