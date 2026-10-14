package main

import (
	"embed"
	"encoding/json"
	"html"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	ttl         = 24 * time.Hour // subdomain list from crt.sh
	checkTTL    = time.Hour      // probe results
	probeClient = &http.Client{Timeout: 5 * time.Second}
	manifestRe  = regexp.MustCompile(`(?is)<link[^>]+rel=["']?manifest["']?[^>]*>`)
	iconRe      = regexp.MustCompile(`(?is)<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>`)
	hrefRe      = regexp.MustCompile(`(?is)href=["']([^"']+)["']`)
)

//go:embed static/*
var embedFS embed.FS

type service struct {
	Host        string `json:"host"`
	Issued      string `json:"issued"` // date of the latest certificate
	Status      int    `json:"status"`
	Error       string `json:"error,omitempty"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	Favicon     string `json:"favicon,omitempty"`
}

type cacheEntry struct {
	FetchedAt time.Time `json:"fetched_at"`
	CheckedAt time.Time `json:"checked_at"`
	Services  []service `json:"services"`
}

// fetchSubdomains lists the subdomains in the CT logs with the date of their latest certificate.
func fetchSubdomains(domain string) ([]service, error) {
	client := http.Client{Timeout: 20 * time.Second}
	resp, err := client.Get("https://crt.sh/?output=json&q=" + url.QueryEscape("%."+domain))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var certs []struct {
		NameValue string `json:"name_value"`
		NotBefore string `json:"not_before"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&certs); err != nil {
		return nil, err
	}
	latest := map[string]string{}
	for _, c := range certs {
		for _, name := range strings.Fields(strings.ToLower(c.NameValue)) {
			// ISO timestamps compare as strings.
			if strings.HasSuffix(name, "."+domain) && !strings.HasPrefix(name, "*") && c.NotBefore > latest[name] {
				latest[name] = c.NotBefore
			}
		}
	}
	var services []service
	for host, issued := range latest {
		services = append(services, service{Host: host, Issued: issued})
	}
	return services, nil
}

// probe requests https://host and extracts its favicon and web app manifest name and description.
func probe(s service) service {
	s = service{Host: s.Host, Issued: s.Issued}
	resp, err := probeClient.Get("https://" + s.Host)
	if err != nil {
		s.Error = err.Error()
		return s
	}
	defer resp.Body.Close()
	s.Status = resp.StatusCode
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	// Links are resolved against the final URL, since the request may have been redirected.
	if m := hrefRe.FindSubmatch(iconRe.Find(body)); m != nil {
		if u, err := resp.Request.URL.Parse(html.UnescapeString(string(m[1]))); err == nil {
			s.Favicon = u.String()
		}
	}
	if m := hrefRe.FindSubmatch(manifestRe.Find(body)); m != nil {
		if u, err := resp.Request.URL.Parse(html.UnescapeString(string(m[1]))); err == nil {
			if r, err := probeClient.Get(u.String()); err == nil {
				var manifest struct{ Name, Description string }
				json.NewDecoder(r.Body).Decode(&manifest)
				r.Body.Close()
				s.Name, s.Description = manifest.Name, manifest.Description
			}
		}
	}
	return s
}

// getServices returns the probed subdomains of domain, refreshing outdated parts of the cache.
func getServices(domain string, refresh bool) cacheEntry {
	// Base keeps the domain from escaping the cache directory.
	file := filepath.Join("cache", filepath.Base(domain)+".json")
	var e cacheEntry
	if data, err := os.ReadFile(file); err == nil {
		json.Unmarshal(data, &e)
	}
	if refresh || time.Since(e.FetchedAt) > ttl {
		// On errors keep the cached list, crt.sh is flaky.
		if services, err := fetchSubdomains(domain); err == nil {
			e.FetchedAt, e.CheckedAt, e.Services = time.Now(), time.Time{}, services
		}
	}
	if refresh || time.Since(e.CheckedAt) > checkTTL {
		for i := range e.Services {
			e.Services[i] = probe(e.Services[i])
		}
		e.CheckedAt = time.Now()
	}
	data, _ := json.Marshal(e)
	os.MkdirAll("cache", 0o755)
	os.WriteFile(file, data, 0o644)
	return e
}

func apiHandler(w http.ResponseWriter, r *http.Request) {
	e := getServices(strings.ToLower(r.URL.Query().Get("domain")), r.URL.Query().Has("refresh"))
	json.NewEncoder(w).Encode(map[string]any{
		"subdomains": e.Services,
		"checked_at": e.CheckedAt,
	})
}

func main() {
	staticFS, _ := fs.Sub(embedFS, "static")
	http.Handle("/", http.FileServer(http.FS(staticFS)))
	http.HandleFunc("/api/subdomains", apiHandler)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
