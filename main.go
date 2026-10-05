package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type ctCert struct {
	NameValue string `json:"name_value"`
}

type cacheEntry struct {
	subdomains []string
	expiresAt  time.Time
}

var (
	cache   = make(map[string]cacheEntry)
	cacheMu sync.RWMutex
	ttl     = 15 * time.Minute
	client  = &http.Client{Timeout: 20 * time.Second}
)

func fetchSubdomains(domain string) ([]string, error) {
	u := &url.URL{
		Scheme: "https",
		Host:   "crt.sh",
		Path:   "/",
	}
	q := u.Query()
	q.Set("q", "%."+domain)
	q.Set("output", "json")
	u.RawQuery = q.Encode()

	resp, err := client.Get(u.String())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("crt.sh status: %d", resp.StatusCode)
	}

	var certs []ctCert
	if err := json.NewDecoder(resp.Body).Decode(&certs); err != nil {
		return nil, err
	}

	set := make(map[string]struct{})
	for _, c := range certs {
		for _, name := range strings.Split(c.NameValue, "\n") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			name = strings.ToLower(name)
			if !strings.HasSuffix(name, "."+domain) && name != domain {
				continue
			}
			set[name] = struct{}{}
		}
	}

	list := make([]string, 0, len(set))
	for s := range set {
		list = append(list, s)
	}
	sort.Strings(list)
	return list, nil
}

func getSubdomains(domain string) ([]string, error) {
	now := time.Now()

	cacheMu.RLock()
	if e, ok := cache[domain]; ok && now.Before(e.expiresAt) {
		cacheMu.RUnlock()
		return e.subdomains, nil
	}
	cacheMu.RUnlock()

	list, err := fetchSubdomains(domain)
	if err != nil {
		return nil, err
	}

	cacheMu.Lock()
	cache[domain] = cacheEntry{subdomains: list, expiresAt: now.Add(ttl)}
	cacheMu.Unlock()

	return list, nil
}

func extractBaseDomain(host string) (string, error) {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	parts := strings.Split(h, ".")
	if len(parts) < 2 {
		return "", fmt.Errorf("invalid host: %s", host)
	}
	base := strings.Join(parts[len(parts)-2:], ".")
	return base, nil
}

func apiHandler(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("domain")
	if host == "" {
		// Fallback to Host header if no domain param
		h := r.Host
		if h == "" {
			http.Error(w, "missing domain", http.StatusBadRequest)
			return
		}
		var err error
		host, err = extractBaseDomain(h)
		if err != nil {
			http.Error(w, "cannot determine domain", http.StatusBadRequest)
			return
		}
	}

	subs, err := getSubdomains(host)
	if err != nil {
		http.Error(w, "error fetching subdomains", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"domain":     host,
		"subdomains": subs,
		"cached_ttl": ttl.String(),
	})
}

func main() {
	// Serve static files from ./static
	staticFS, err := fs.Sub(embedFS, "static")
	if err != nil {
		panic(err)
	}
	http.Handle("/", http.FileServer(http.FS(staticFS)))
	http.HandleFunc("/api/subdomains", apiHandler)

	port := "8080"
	fmt.Println("listening on :" + port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Println(err)
	}
}

//go:embed static/*
var embedFS embed.FS
