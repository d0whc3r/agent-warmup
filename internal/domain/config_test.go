package domain

import "testing"

func TestParseProviderID(t *testing.T) {
	for _, id := range ProviderIDs {
		if got, err := ParseProviderID(string(id)); got != id || err != nil {
			t.Errorf("ParseProviderID(%q) = %q, %v", id, got, err)
		}
	}
	for _, bad := range []string{"", "Claude", "bogus"} {
		if _, err := ParseProviderID(bad); err == nil {
			t.Errorf("ParseProviderID(%q) accepted", bad)
		}
	}
}
