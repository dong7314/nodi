package api

import "encoding/json"

type pageResourceReferences struct {
	databases  []string
	childPages []string
}

// Walk only BlockNote's block tree; ordinary document content is left intact.
// RawMessage preserves custom block properties without rounding JSON numbers.
func mapPageBlocks(value json.RawMessage, visit func(map[string]json.RawMessage)) (json.RawMessage, error) {
	var blocks []map[string]json.RawMessage
	if err := json.Unmarshal(value, &blocks); err != nil {
		return nil, err
	}
	for _, block := range blocks {
		visit(block)
		if children := block["children"]; len(children) > 0 && string(children) != "null" {
			mapped, err := mapPageBlocks(children, visit)
			if err != nil {
				return nil, err
			}
			block["children"] = mapped
		}
	}
	return json.Marshal(blocks)
}

func blockString(value json.RawMessage) string {
	var result string
	_ = json.Unmarshal(value, &result)
	return result
}

func pageResourceIDs(blocks json.RawMessage) (pageResourceReferences, error) {
	refs := pageResourceReferences{databases: []string{}, childPages: []string{}}
	_, err := mapPageBlocks(blocks, func(block map[string]json.RawMessage) {
		var props map[string]json.RawMessage
		_ = json.Unmarshal(block["props"], &props)
		switch blockString(block["type"]) {
		case "database":
			id := blockString(props["databaseId"])
			if id == "" {
				if blockID := blockString(block["id"]); blockID != "" {
					id = "database-" + blockID
				}
			}
			if id != "" {
				refs.databases = append(refs.databases, id)
			}
		case "childPage":
			if id := blockString(props["pageId"]); id != "" {
				refs.childPages = append(refs.childPages, id)
			}
		}
	})
	return refs, err
}

func publicPageBlocks(blocks json.RawMessage, childTitles map[string]string) (json.RawMessage, error) {
	return mapPageBlocks(blocks, func(block map[string]json.RawMessage) {
		if blockString(block["type"]) != "childPage" {
			return
		}
		var props map[string]json.RawMessage
		_ = json.Unmarshal(block["props"], &props)
		if props == nil {
			props = make(map[string]json.RawMessage)
		}
		title, public := childTitles[blockString(props["pageId"])]
		if !public {
			title = "비공개 페이지"
			props["pageId"] = json.RawMessage(`""`)
		}
		props["title"], _ = json.Marshal(title)
		block["props"], _ = json.Marshal(props)
	})
}

func publicDatabaseState(state json.RawMessage) (json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(state, &value); err != nil {
		return nil, err
	}
	if value == nil {
		value = make(map[string]json.RawMessage)
	}
	// Keep the existing renderer's shape, but never publish deleted records.
	value["trash"] = json.RawMessage(`[]`)
	return json.Marshal(value)
}
