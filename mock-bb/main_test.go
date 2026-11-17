package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func testServer(t *testing.T, mutate func(*config)) (*server, *httptest.Server) {
	t.Helper()
	c := defaultConfig()
	c.StepDelay.Duration = 5 * time.Millisecond
	c.HeartbeatEvery.Duration = 0
	c.ResultAfter = 3
	if mutate != nil {
		mutate(&c)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s := newServer(ctx, c, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(s.routes())
	t.Cleanup(srv.Close)
	return s, srv
}

func put(t *testing.T, base, id, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, base+"/tasks/"+id, strings.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func readEvents(t *testing.T, url string) []event {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var evs []event
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if data, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
			var ev event
			_ = json.Unmarshal([]byte(data), &ev)
			evs = append(evs, ev)
		}
	}
	return evs
}

const body = `{"protocolVersion":1,"prompt":"do it"}`

func TestIdempotentPutAndOrderedEvents(t *testing.T) {
	s, srv := testServer(t, nil)
	code, a := put(t, srv.URL, "t1", body)
	if code != 200 || a["created"] != true {
		t.Fatalf("first put %d %v", code, a)
	}
	code, b := put(t, srv.URL, "t1", body)
	if code != 200 || b["created"] != false {
		t.Fatalf("second put %d %v", code, b)
	}
	evs := readEvents(t, srv.URL+"/tasks/t1/events?since=0")
	for i, ev := range evs {
		if ev.ID != int64(i+1) {
			t.Fatalf("event %d has id %d", i, ev.ID)
		}
	}
	if last := evs[len(evs)-1]; last.Kind != "result" || last.Status != "succeeded" {
		t.Fatalf("last = %+v", last)
	}
	tail := readEvents(t, srv.URL+"/tasks/t1/events?since=3")
	if len(tail) != len(evs)-3 || tail[0].ID != 4 {
		t.Fatalf("since=3 returned %d events starting %d", len(tail), tail[0].ID)
	}
	if s.runCount() != 1 {
		t.Fatalf("runs = %d", s.runCount())
	}
}

func TestDuplicatePutSwitchStillOneRun(t *testing.T) {
	s, srv := testServer(t, func(c *config) { c.DuplicatePut = true })
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() { defer wg.Done(); put(t, srv.URL, "dup", body) }()
	}
	wg.Wait()
	if s.runCount() != 1 {
		t.Fatalf("runs = %d, want 1", s.runCount())
	}
}

func TestRetryOfAliasesExistingRun(t *testing.T) {
	s, srv := testServer(t, nil)
	put(t, srv.URL, "a1", body)
	_, r := put(t, srv.URL, "a2", `{"protocolVersion":1,"prompt":"x","retryOf":"a1"}`)
	if r["taskId"] != "a1" || r["created"] != false {
		t.Fatalf("retry put = %v", r)
	}
	_, r = put(t, srv.URL, "a3", `{"protocolVersion":1,"prompt":"x","retryOf":"a2"}`)
	if r["taskId"] != "a1" {
		t.Fatalf("grandchild resolved to %v", r["taskId"])
	}
	if s.runCount() != 1 || len(readEvents(t, srv.URL+"/tasks/a3/events?since=0")) == 0 {
		t.Fatalf("runs=%d", s.runCount())
	}
}

func TestFailFirstAndCancelTombstone(t *testing.T) {
	s, srv := testServer(t, func(c *config) { c.FailFirst = 2 })
	for i := 0; i < 2; i++ {
		if code, _ := put(t, srv.URL, "f", body); code != 503 {
			t.Fatalf("put %d code %d", i, code)
		}
	}
	resp, _ := http.Post(srv.URL+"/tasks/never/cancel", "", nil)
	resp.Body.Close()
	if code, _ := put(t, srv.URL, "never", body); code != http.StatusConflict {
		t.Fatalf("put after tombstone = %d", code)
	}
	if code, _ := put(t, srv.URL, "f", body); code != 200 {
		t.Fatalf("put after failures = %d", code)
	}
	if s.runCount() != 1 {
		t.Fatalf("runs=%d", s.runCount())
	}
}

func TestAcceptThenDropPersists(t *testing.T) {
	s, srv := testServer(t, func(c *config) { c.AcceptThenDrop = 1 })
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/tasks/d", strings.NewReader(body))
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Fatal("expected the connection to drop")
	}
	if _, r := put(t, srv.URL, "d", body); r["created"] != false {
		t.Fatalf("retry after drop = %v", r)
	}
	if s.runCount() != 1 {
		t.Fatalf("runs=%d", s.runCount())
	}
}

func TestSilentRunEmitsNothing(t *testing.T) {
	s, srv := testServer(t, func(c *config) {
		c.SilentFor.Duration = 300 * time.Millisecond
		c.HeartbeatEvery.Duration = 20 * time.Millisecond
	})
	put(t, srv.URL, "q", body)
	time.Sleep(200 * time.Millisecond)
	s.mu.Lock()
	n := len(s.tasks["q"].events)
	s.mu.Unlock()
	if n != 1 {
		t.Fatalf("silent run has %d events, want just the first thought", n)
	}
}

func (s *server) runCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}
