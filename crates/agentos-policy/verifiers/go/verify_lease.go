// Portable lease verifier (V6-05-09) — Go reference implementation.
//
// Usage: go run . <fixture-dir>
//
// Third independent implementation of the same contract: strict JSON schema (unknown
// fields are an error), canonical rebuild, SHA-256 comparison, Ed25519 verification.
// Standard library only, so `go run` works offline.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const domain = "uap-lease/1"

type revocation struct {
	List    string `json:"list"`
	Version uint64 `json:"version"`
}

type fields struct {
	V           string     `json:"v"`
	LeaseID     string     `json:"lease_id"`
	TaskID      string     `json:"task_id"`
	Tenant      string     `json:"tenant"`
	SID         string     `json:"sid"`
	RoleDigest  string     `json:"role_digest"`
	GrantID     string     `json:"grant_id"`
	Epoch       uint64     `json:"epoch"`
	IssuedAtMS  uint64     `json:"issued_at_ms"`
	ExpiresAtMS uint64     `json:"expires_at_ms"`
	Revocation  revocation `json:"revocation"`
	Nonce       string     `json:"nonce"`
}

type outcome struct {
	verified bool
	reason   string
	digest   string
}

func safeID(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x21 || c > 0x7e || c == '"' || c == '\\' {
			return false
		}
	}
	return true
}

func hex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// canonical rebuilds the signed bytes. Order is fixed by the protocol.
func canonical(f *fields) string {
	var b strings.Builder
	b.WriteString(`{"v":"` + f.V + `"`)
	b.WriteString(`,"lease_id":"` + f.LeaseID + `"`)
	b.WriteString(`,"task_id":"` + f.TaskID + `"`)
	b.WriteString(`,"tenant":"` + f.Tenant + `"`)
	b.WriteString(`,"sid":"` + f.SID + `"`)
	b.WriteString(`,"role_digest":"` + f.RoleDigest + `"`)
	b.WriteString(`,"grant_id":"` + f.GrantID + `"`)
	fmt.Fprintf(&b, `,"epoch":%d`, f.Epoch)
	fmt.Fprintf(&b, `,"issued_at_ms":%d`, f.IssuedAtMS)
	fmt.Fprintf(&b, `,"expires_at_ms":%d`, f.ExpiresAtMS)
	b.WriteString(`,"revocation":{"list":"` + f.Revocation.List + `"`)
	fmt.Fprintf(&b, `,"version":%d}`, f.Revocation.Version)
	b.WriteString(`,"nonce":"` + f.Nonce + `"}`)
	return b.String()
}

func verify(dir string) outcome {
	raw, err := os.ReadFile(filepath.Join(dir, "fields.json"))
	if err != nil {
		return outcome{false, "fields.json: " + err.Error(), ""}
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	var f fields
	if err := dec.Decode(&f); err != nil {
		return outcome{false, "schema: " + err.Error(), ""}
	}
	if dec.More() {
		return outcome{false, "schema: trailing data after object", ""}
	}
	if f.V != domain {
		return outcome{false, fmt.Sprintf("schema: v is %q", f.V), ""}
	}
	for _, s := range []string{f.LeaseID, f.TaskID, f.Tenant, f.SID, f.GrantID, f.Revocation.List} {
		if !safeID(s) {
			return outcome{false, "schema: identifier outside the safe charset", ""}
		}
	}
	if !hex64(f.RoleDigest) || !hex64(f.Nonce) {
		return outcome{false, "schema: digest is not 64 lowercase hex", ""}
	}

	body := canonical(&f)
	sum := sha256.Sum256([]byte(body))
	digest := hex.EncodeToString(sum[:])

	wantRaw, err := os.ReadFile(filepath.Join(dir, "canonical.sha256"))
	if err != nil {
		return outcome{false, "canonical.sha256: " + err.Error(), digest}
	}
	want := strings.TrimSpace(string(wantRaw))
	if digest != want {
		return outcome{false, fmt.Sprintf("canonical bytes differ (built %s, expected %s)", digest, want), digest}
	}

	sigRaw, err := os.ReadFile(filepath.Join(dir, "sig.hex"))
	if err != nil {
		return outcome{false, "sig.hex: " + err.Error(), digest}
	}
	pubRaw, err := os.ReadFile(filepath.Join(dir, "issuer.pub.hex"))
	if err != nil {
		return outcome{false, "issuer.pub.hex: " + err.Error(), digest}
	}
	sig, err := hex.DecodeString(strings.TrimSpace(string(sigRaw)))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return outcome{false, "signature is not 64 bytes of hex", digest}
	}
	pub, err := hex.DecodeString(strings.TrimSpace(string(pubRaw)))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return outcome{false, "public key is not 32 bytes of hex", digest}
	}
	payload := append([]byte(domain+"\n"), []byte(body)...)
	if !ed25519.Verify(ed25519.PublicKey(pub), payload, sig) {
		return outcome{false, "signature does not verify", digest}
	}
	return outcome{true, "ok", digest}
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: verify-lease <fixture-dir>")
		os.Exit(2)
	}
	dir := os.Args[1]
	name := filepath.Base(dir)
	wantRaw, err := os.ReadFile(filepath.Join(dir, "expect.txt"))
	if err != nil {
		fmt.Printf("verify-lease %s: error=expect.txt:%v\n", name, err)
		os.Exit(1)
	}
	want := strings.TrimSpace(string(wantRaw))
	if want != "valid" && want != "invalid" {
		fmt.Printf("verify-lease %s: error=expect.txt is %q\n", name, want)
		os.Exit(1)
	}
	res := verify(dir)
	got := "invalid"
	if res.verified {
		got = "valid"
	}
	digest := res.digest
	if digest == "" {
		digest = "-"
	}
	fmt.Printf("verify-lease %s: expect=%s got=%s sha256=%s reason=%s\n", name, want, got, digest, res.reason)
	if got != want {
		os.Exit(1)
	}
}
