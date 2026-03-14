//
// Strux Client - Host Discovery
//
// Discovers dev server hosts using:
// 1. Fallback hosts from configuration
// 2. mDNS/Bonjour discovery (optional)
//

package main

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/grandcat/zeroconf"
)

// waitForNetwork waits until the device has a global IPv4 address and a default route
func waitForNetwork(logger *Logger, timeout time.Duration) bool {
	logger.Info("Waiting for network to be ready (timeout: %v)...", timeout)
	deadline := time.Now().Add(timeout)
	attempt := 0

	for time.Now().Before(deadline) {
		attempt++

		// Check for a global IPv4 address
		out, err := exec.Command("ip", "-4", "-o", "addr", "show", "scope", "global").Output()
		if err != nil || !strings.Contains(string(out), "inet ") {
			if attempt%10 == 1 {
				logger.Info("No global IPv4 address yet (attempt %d)", attempt)
			}
			time.Sleep(500 * time.Millisecond)
			continue
		}

		// Check for a default route
		err = exec.Command("sh", "-c", "ip route | grep -q '^default '").Run()
		if err != nil {
			if attempt%10 == 1 {
				logger.Info("No default route yet (attempt %d)", attempt)
			}
			time.Sleep(500 * time.Millisecond)
			continue
		}

		logger.Info("Network is ready (after %d attempts)", attempt)
		return true
	}

	logger.Warn("Network did not become ready within %v", timeout)
	return false
}

// DiscoverHosts finds all available dev server hosts
func DiscoverHosts(config *Config) []Host {
	logger := NewLogger("HostDiscovery")

	// If mDNS is disabled, return fallback hosts only
	if !config.UseMDNS {
		logger.Info("mDNS discovery disabled, using fallback hosts only")
		hosts := make([]Host, 0, len(config.FallbackHosts))
		for _, host := range config.FallbackHosts {
			hosts = append(hosts, host)
			logger.Info("Added fallback host: %s:%d", host.Host, host.Port)
		}
		return hosts
	}

	// Wait for network before starting mDNS - discovery requires an IP address
	if !waitForNetwork(logger, 30*time.Second) {
		logger.Warn("Network not ready, falling back to configured hosts")
		return config.FallbackHosts
	}

	// Perform mDNS discovery
	logger.Info("Starting mDNS discovery for 'strux-dev' service...")

	// Create resolver
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		logger.Warn("Failed to create mDNS resolver: %v", err)
		return config.FallbackHosts
	}

	// Create channel for discovered entries
	entries := make(chan *zeroconf.ServiceEntry)

	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Start browsing in background
	go func() {
		err := resolver.Browse(ctx, "_strux-dev._tcp", "local.", entries)
		if err != nil {
			logger.Warn("mDNS browse error: %v", err)
		}
	}()

	// Collect discovered services - mDNS hosts are prioritized over fallback hosts
	logger.Info("Waiting 5 seconds for mDNS discovery...")
	mdnsHosts := make([]Host, 0)

	for {
		select {
		case entry := <-entries:
			if entry != nil {
				// Use the first IPv4 address
				for _, addr := range entry.AddrIPv4 {
					host := Host{
						Host: addr.String(),
						Port: entry.Port,
					}
					mdnsHosts = append(mdnsHosts, host)
					logger.Info("Found mDNS service: %s:%d", host.Host, host.Port)
					break
				}
			}
		case <-ctx.Done():
			// If mDNS found hosts, use those first, then fallback hosts
			hosts := make([]Host, 0, len(mdnsHosts)+len(config.FallbackHosts))
			hosts = append(hosts, mdnsHosts...)
			if len(config.FallbackHosts) > 0 {
				logger.Info("Adding %d fallback host(s) after %d mDNS host(s)", len(config.FallbackHosts), len(mdnsHosts))
				hosts = append(hosts, config.FallbackHosts...)
			}
			logger.Info("Discovery complete: %d host(s) found", len(hosts))
			return hosts
		}
	}
}
