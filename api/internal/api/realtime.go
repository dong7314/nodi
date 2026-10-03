package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/net/websocket"
)

type pageRealtimeParticipant struct {
	User          authUser `json:"user"`
	ActiveBlockID string   `json:"activeBlockId,omitempty"`
}

type pageRealtimeEvent struct {
	Type            string                    `json:"type"`
	Page            *page                     `json:"page,omitempty"`
	Database        *inlineDatabase           `json:"database,omitempty"`
	DatabaseID      string                    `json:"databaseId,omitempty"`
	Permission      string                    `json:"permission,omitempty"`
	ActorID         string                    `json:"actorId,omitempty"`
	MutationID      string                    `json:"mutationId,omitempty"`
	Message         string                    `json:"message,omitempty"`
	Code            string                    `json:"code,omitempty"`
	Participants    []pageRealtimeParticipant `json:"participants,omitempty"`
	ChangedBlockIDs []string                  `json:"changedBlockIds,omitempty"`
	DeletedBlockIDs []string                  `json:"deletedBlockIds,omitempty"`
	Structural      bool                      `json:"structural,omitempty"`
}

type pageRealtimeClient struct {
	pageID         string
	user           authUser
	activeBlockID  string
	conn           *websocket.Conn
	writeMu        sync.Mutex
	sessionHash    []byte
	sendAuthorized func(pageRealtimeEvent) error
}

func (c *pageRealtimeClient) send(event pageRealtimeEvent) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.sendAuthorized != nil {
		return c.sendAuthorized(event)
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return websocket.JSON.Send(c.conn, event)
}

func (s *Server) sendRealtimeEvent(r *http.Request, client *pageRealtimeClient, event pageRealtimeEvent) error {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	expires, err := realtimeSession(ctx, tx, client.sessionHash, client.user.ID, true)
	if err != nil {
		return err
	}
	ctx, cancelExpiry := context.WithDeadline(ctx, expires)
	defer cancelExpiry()
	switch event.Type {
	case "access.revoked", "page.archived", "page.deleted":
		// These terminal signals must reach clients that just lost access, but
		// must never carry the old page body or other private event fields.
		event = pageRealtimeEvent{Type: event.Type, Message: event.Message}
	default:
		if err = lockPageACL(ctx, tx, client.pageID, false); err != nil {
			return err
		}
		var id string
		if err = tx.QueryRow(ctx, `SELECT id FROM pages WHERE id=$1 FOR SHARE`, client.pageID).Scan(&id); err != nil {
			return err
		}
		// Sharing changes lock the same page. Read the ACL after waiting, and
		// retain the lock through the network write so revocation cannot finish
		// before a frame authorized by the old ACL has been sent.
		access, accessErr := authorizePageWith(r.WithContext(ctx), tx, client.user.ID, client.pageID, "view")
		if accessErr != nil {
			return accessErr
		}
		if event.Type == "permission.updated" {
			event.Permission = access.Permission
		}
		if event.Type == "page.snapshot" {
			value, readErr := scanPageForAccess(tx.QueryRow(ctx, pageSelect+` WHERE p.id=$2 AND (p.owner_id=$1 OR (ps.user_id=$1 AND NOT p.archived))`, client.user.ID, client.pageID), "view")
			if readErr != nil {
				return readErr
			}
			event.Page = &value
		}
	}
	deadline, _ := ctx.Deadline()
	if err = ctx.Err(); err != nil {
		return err
	}
	_ = client.conn.SetWriteDeadline(deadline)
	if err = websocket.JSON.Send(client.conn, event); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type pageRealtimeHub struct {
	mu    sync.RWMutex
	rooms map[string]map[*pageRealtimeClient]struct{}
}

func newPageRealtimeHub() *pageRealtimeHub {
	return &pageRealtimeHub{rooms: make(map[string]map[*pageRealtimeClient]struct{})}
}

func (h *pageRealtimeHub) register(client *pageRealtimeClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[client.pageID]
	if room == nil {
		room = make(map[*pageRealtimeClient]struct{})
		h.rooms[client.pageID] = room
	}
	room[client] = struct{}{}
}

func (h *pageRealtimeHub) unregister(client *pageRealtimeClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[client.pageID]
	if room == nil {
		return
	}
	delete(room, client)
	if len(room) == 0 {
		delete(h.rooms, client.pageID)
	}
}

func (h *pageRealtimeHub) updatePresence(client *pageRealtimeClient, activeBlockID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, connected := h.rooms[client.pageID][client]; connected {
		client.activeBlockID = activeBlockID
	}
}

func (h *pageRealtimeHub) clients(pageID string) []*pageRealtimeClient {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[pageID]
	clients := make([]*pageRealtimeClient, 0, len(room))
	for client := range room {
		clients = append(clients, client)
	}
	return clients
}

func (h *pageRealtimeHub) participants(pageID string) []pageRealtimeParticipant {
	h.mu.RLock()
	defer h.mu.RUnlock()

	// One user can have the same page open in more than one tab. Presence is
	// user-oriented, so collapse those sockets and prefer a tab that currently
	// has an active block.
	byUser := make(map[uuid.UUID]pageRealtimeParticipant)
	for client := range h.rooms[pageID] {
		participant, exists := byUser[client.user.ID]
		if !exists || (participant.ActiveBlockID == "" && client.activeBlockID != "") {
			byUser[client.user.ID] = pageRealtimeParticipant{
				User:          client.user,
				ActiveBlockID: client.activeBlockID,
			}
		}
	}
	participants := make([]pageRealtimeParticipant, 0, len(byUser))
	for _, participant := range byUser {
		participants = append(participants, participant)
	}
	sort.Slice(participants, func(i, j int) bool {
		left, right := strings.ToLower(participants[i].User.Name), strings.ToLower(participants[j].User.Name)
		if left == right {
			return participants[i].User.ID.String() < participants[j].User.ID.String()
		}
		return left < right
	})
	return participants
}

func (h *pageRealtimeHub) broadcast(pageID string, event pageRealtimeEvent) {
	for _, client := range h.clients(pageID) {
		if err := client.send(event); err != nil {
			h.unregister(client)
			_ = client.conn.Close()
		}
	}
}

func (h *pageRealtimeHub) broadcastPresence(pageID string) {
	h.broadcast(pageID, pageRealtimeEvent{
		Type:         "presence.updated",
		Participants: h.participants(pageID),
	})
}

func (h *pageRealtimeHub) sendTo(pageID string, userID uuid.UUID, event pageRealtimeEvent) {
	for _, client := range h.clients(pageID) {
		if client.user.ID != userID {
			continue
		}
		if err := client.send(event); err != nil {
			h.unregister(client)
			_ = client.conn.Close()
		}
	}
}

func (h *pageRealtimeHub) revoke(pageID string, userID uuid.UUID) {
	for _, client := range h.clients(pageID) {
		if client.user.ID != userID {
			continue
		}
		_ = client.send(pageRealtimeEvent{
			Type:    "access.revoked",
			Message: "이 페이지의 공유 권한이 해제되었습니다.",
		})
		h.unregister(client)
		_ = client.conn.Close()
	}
	h.broadcastPresence(pageID)
}

func (h *pageRealtimeHub) disconnectMatching(matches func(*pageRealtimeClient) bool) {
	h.mu.Lock()
	var clients []*pageRealtimeClient
	for pageID, room := range h.rooms {
		for client := range room {
			if matches(client) {
				clients = append(clients, client)
				delete(room, client)
			}
		}
		if len(room) == 0 {
			delete(h.rooms, pageID)
		}
	}
	h.mu.Unlock()
	for _, client := range clients {
		_ = client.conn.Close()
	}
}

func (h *pageRealtimeHub) revokeSession(hash []byte) {
	h.disconnectMatching(func(client *pageRealtimeClient) bool { return equalBytes(client.sessionHash, hash) })
}

func (h *pageRealtimeHub) revokeUser(userID uuid.UUID) {
	h.disconnectMatching(func(client *pageRealtimeClient) bool { return client.user.ID == userID })
}

func realtimeSession(ctx context.Context, query rowQuerier, hash []byte, userID uuid.UUID, lock bool) (time.Time, error) {
	if lock {
		// Password changes lock the user before deleting its sessions. Use the
		// same order here to avoid a user/session lock inversion.
		var id uuid.UUID
		if err := query.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND status='approved' FOR SHARE`, userID).Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return time.Time{}, &apiError{Status: http.StatusUnauthorized, Code: "INVALID_SESSION", Message: "로그인 세션이 만료되었습니다."}
			}
			return time.Time{}, err
		}
	}
	sql := `SELECT ss.expires_at FROM sessions ss JOIN users u ON u.id=ss.user_id
		WHERE ss.token_hash=$1 AND ss.user_id=$2 AND ss.expires_at>clock_timestamp() AND u.status='approved'`
	if lock {
		// Revoking a session/account waits for an already authorized mutation to
		// commit, so no write can finish after the revocation response.
		sql += ` FOR SHARE OF ss`
	}
	var expires time.Time
	err := query.QueryRow(ctx, sql, hash, userID).Scan(&expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, &apiError{Status: http.StatusUnauthorized, Code: "INVALID_SESSION", Message: "로그인 세션이 만료되었습니다."}
	}
	return expires, err
}

type realtimeBlockEnvelope struct {
	ID string `json:"id"`
}

func decodeRealtimeBlocks(value json.RawMessage) ([]json.RawMessage, []string, error) {
	var blocks []json.RawMessage
	if err := json.Unmarshal(value, &blocks); err != nil || blocks == nil {
		return nil, nil, fmt.Errorf("blocks must be a JSON array")
	}
	ids := make([]string, 0, len(blocks))
	seen := make(map[string]struct{}, len(blocks))
	for _, block := range blocks {
		var envelope realtimeBlockEnvelope
		if err := json.Unmarshal(block, &envelope); err != nil || strings.TrimSpace(envelope.ID) == "" {
			return nil, nil, fmt.Errorf("each block must have an id")
		}
		if _, duplicate := seen[envelope.ID]; duplicate {
			return nil, nil, fmt.Errorf("block ids must be unique")
		}
		seen[envelope.ID] = struct{}{}
		ids = append(ids, envelope.ID)
	}
	return blocks, ids, nil
}

func realtimeBlocksMissingIDs(value json.RawMessage) bool {
	var blocks []json.RawMessage
	if err := json.Unmarshal(value, &blocks); err != nil || blocks == nil {
		return false
	}
	for _, block := range blocks {
		var envelope realtimeBlockEnvelope
		if err := json.Unmarshal(block, &envelope); err != nil {
			return false
		}
		if strings.TrimSpace(envelope.ID) == "" {
			return true
		}
	}
	return false
}

// mergeRealtimeBlocks applies only the blocks changed by the sender to the
// latest canonical document. That keeps concurrent edits in other blocks and
// avoids the previous whole-document last-write-wins data loss.
func mergeRealtimeBlocks(current, incoming json.RawMessage, changedIDs, deletedIDs []string, structural bool) (json.RawMessage, error) {
	currentBlocks, currentOrder, err := decodeRealtimeBlocks(current)
	if err != nil {
		if !realtimeBlocksMissingIDs(current) {
			return nil, err
		}
		// Pages created before realtime collaboration can contain valid BlockNote
		// blocks without stable IDs. The browser has already normalized the full
		// document by the time it sends its first patch, so accept that document
		// once as the canonical ID-bearing baseline. Subsequent edits use the
		// regular block-level merge path below.
		incomingBlocks, _, incomingErr := decodeRealtimeBlocks(incoming)
		if incomingErr != nil {
			return nil, incomingErr
		}
		return json.Marshal(incomingBlocks)
	}
	incomingBlocks, incomingOrder, err := decodeRealtimeBlocks(incoming)
	if err != nil {
		return nil, err
	}
	if len(changedIDs) > 5000 || len(deletedIDs) > 5000 {
		return nil, fmt.Errorf("too many block changes")
	}

	currentByID := make(map[string]json.RawMessage, len(currentBlocks))
	for index, id := range currentOrder {
		currentByID[id] = currentBlocks[index]
	}
	incomingByID := make(map[string]json.RawMessage, len(incomingBlocks))
	for index, id := range incomingOrder {
		incomingByID[id] = incomingBlocks[index]
	}
	changed := make(map[string]struct{}, len(changedIDs))
	for _, id := range changedIDs {
		if _, exists := incomingByID[id]; !exists {
			return nil, fmt.Errorf("changed block %q is missing", id)
		}
		changed[id] = struct{}{}
		currentByID[id] = incomingByID[id]
	}
	deleted := make(map[string]struct{}, len(deletedIDs))
	for _, id := range deletedIDs {
		deleted[id] = struct{}{}
		delete(currentByID, id)
	}

	order := currentOrder
	if structural {
		order = incomingOrder
	}
	result := make([]json.RawMessage, 0, len(currentByID))
	added := make(map[string]struct{}, len(currentByID))
	for _, id := range order {
		if _, removed := deleted[id]; removed {
			continue
		}
		block, exists := currentByID[id]
		if !exists {
			// A newly inserted sender block is represented as changed. Unchanged
			// unknown blocks are never allowed to overwrite canonical state.
			if _, isChanged := changed[id]; !isChanged {
				continue
			}
			block = incomingByID[id]
		}
		result = append(result, block)
		added[id] = struct{}{}
	}
	// Keep blocks concurrently inserted by another participant even when the
	// sender's structural order did not know about them yet.
	for _, id := range currentOrder {
		if _, exists := added[id]; exists {
			continue
		}
		if block, exists := currentByID[id]; exists {
			result = append(result, block)
			added[id] = struct{}{}
		}
	}
	for _, id := range changedIDs {
		if _, exists := added[id]; exists {
			continue
		}
		result = append(result, incomingByID[id])
		added[id] = struct{}{}
	}
	return json.Marshal(result)
}

func (s *Server) applyRealtimeBlocks(r *http.Request, user authUser, pageID string, message struct {
	Blocks          json.RawMessage
	ChangedBlockIDs []string
	DeletedBlockIDs []string
	Structural      bool
}) (page, error) {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return page{}, err
	}
	defer tx.Rollback(r.Context())
	expires, err := realtimeSession(r.Context(), tx, tokenHash(sessionToken(r)), user.ID, true)
	if err != nil {
		return page{}, err
	}
	// A patch may wait for a page lock. Its authorization must not outlive the
	// session while it is queued, or while PostgreSQL is processing the write.
	ctx, cancel := context.WithDeadline(r.Context(), expires)
	defer cancel()
	// Serialize merges for this page. Without the row lock, two participants
	// could both read revision N and the second UPDATE would erase the first
	// participant's freshly merged block.
	current, err := pageForUpdate(ctx, tx, user.ID, pageID, "edit")
	if err != nil {
		return page{}, err
	}
	if pageSettingsLocked(current.Settings) {
		return page{}, &apiError{Status: http.StatusLocked, Code: "PAGE_LOCKED", Message: "잠긴 페이지의 블록은 변경할 수 없습니다."}
	}
	merged, err := mergeRealtimeBlocks(current.Blocks, message.Blocks, message.ChangedBlockIDs, message.DeletedBlockIDs, message.Structural)
	if err != nil {
		return page{}, &apiError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "실시간 블록 변경 형식이 올바르지 않습니다."}
	}
	if jsonValuesEqual(current.Blocks, merged) {
		if err = tx.Commit(ctx); err != nil {
			return page{}, err
		}
		return current, nil
	}
	if err = tx.QueryRow(ctx, `UPDATE pages SET blocks_json=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING revision,updated_at`, merged, pageID).Scan(&current.Revision, &current.UpdatedAt); err != nil {
		return page{}, err
	}
	if err = s.syncAttachmentReferences(ctx, tx, user.ID, attachmentReferenceTarget{pageID: &pageID}, merged, current.Blocks); err != nil {
		return page{}, err
	}
	current.Blocks = merged
	if err = tx.Commit(ctx); err != nil {
		return page{}, err
	}
	return current, nil
}

func (s *Server) pageRealtime(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	_, err = s.authorizePage(r, user.ID, pageID, "view")
	if err != nil {
		handleError(w, err)
		return
	}
	sessionHash := tokenHash(sessionToken(r))
	expires, err := realtimeSession(r.Context(), s.pool, sessionHash, user.ID, false)
	if err != nil {
		handleError(w, err)
		return
	}

	server := websocket.Server{
		// Origin validation is already performed by the CORS middleware before
		// this handler. The Vite proxy also rewrites local development origins.
		Handshake: func(*websocket.Config, *http.Request) error { return nil },
		Handler: func(conn *websocket.Conn) {
			conn.MaxPayloadBytes = int(s.config.MaxBodyBytes)
			validSession := func() bool {
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				defer cancel()
				_, err := realtimeSession(ctx, s.pool, sessionHash, user.ID, false)
				return err == nil
			}
			client := &pageRealtimeClient{pageID: pageID, user: user, conn: conn, sessionHash: sessionHash}
			client.sendAuthorized = func(event pageRealtimeEvent) error { return s.sendRealtimeEvent(r, client, event) }
			s.realtime.register(client)
			expiry := time.AfterFunc(time.Until(expires), func() { _ = conn.Close() })
			defer expiry.Stop()
			defer func() {
				s.realtime.unregister(client)
				s.realtime.broadcastPresence(pageID)
				_ = conn.Close()
			}()

			if err := client.send(pageRealtimeEvent{Type: "page.snapshot"}); err != nil {
				return
			}
			s.realtime.broadcastPresence(pageID)
			for {
				var message struct {
					Type            string          `json:"type"`
					Blocks          json.RawMessage `json:"blocks"`
					ChangedBlockIDs []string        `json:"changedBlockIds"`
					DeletedBlockIDs []string        `json:"deletedBlockIds"`
					Structural      bool            `json:"structural"`
					ActiveBlockID   string          `json:"activeBlockId"`
					MutationID      string          `json:"mutationId"`
				}
				if err := websocket.JSON.Receive(conn, &message); err != nil {
					return
				}
				// Block patches validate and lock their session inside the mutation
				// transaction; other messages need an explicit authentication check.
				if message.Type != "page.blocks.patch" && !validSession() {
					return
				}
				if len(message.MutationID) > 128 {
					if err := client.send(pageRealtimeEvent{Type: "page.error", Code: "VALIDATION_ERROR", Message: "변경 식별자가 너무 깁니다."}); err != nil {
						return
					}
					continue
				}
				switch message.Type {
				case "ping":
					if err := client.send(pageRealtimeEvent{Type: "pong"}); err != nil {
						return
					}
				case "presence.update":
					activeBlockID := strings.TrimSpace(message.ActiveBlockID)
					if len(activeBlockID) > 200 {
						activeBlockID = ""
					}
					s.realtime.updatePresence(client, activeBlockID)
					s.realtime.broadcastPresence(pageID)
				case "page.blocks.patch":
					updated, updateErr := s.applyRealtimeBlocks(r, user, pageID, struct {
						Blocks          json.RawMessage
						ChangedBlockIDs []string
						DeletedBlockIDs []string
						Structural      bool
					}{message.Blocks, message.ChangedBlockIDs, message.DeletedBlockIDs, message.Structural})
					if updateErr != nil {
						code, text := "REALTIME_UPDATE_FAILED", "실시간 변경을 저장하지 못했습니다."
						if apiErr, ok := updateErr.(*apiError); ok {
							code, text = apiErr.Code, apiErr.Message
						}
						if err := client.send(pageRealtimeEvent{Type: "page.error", Code: code, Message: text, MutationID: message.MutationID}); err != nil {
							return
						}
						continue
					}
					s.realtime.broadcast(pageID, pageRealtimeEvent{
						Type:            "page.updated",
						Page:            &updated,
						ActorID:         user.ID.String(),
						MutationID:      message.MutationID,
						ChangedBlockIDs: message.ChangedBlockIDs,
						DeletedBlockIDs: message.DeletedBlockIDs,
						Structural:      message.Structural,
					})
				}
			}
		},
	}
	server.ServeHTTP(w, r)
}
