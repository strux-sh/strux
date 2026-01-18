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
	"time"

	"github.com/grandcat/zeroconf"
)

// DiscoverHosts finds all available dev server hosts
func DiscoverHosts(config *Config) []Host {
	logger := NewLogger("HostDiscovery")
	hosts := make([]Host, 0)

	// Add fallback hosts first
	if len(config.FallbackHosts) > 0 {
		logger.Info("Adding %d fallback host(s)", len(config.FallbackHosts))
		for _, host := range config.FallbackHosts {
			hosts = append(hosts, host)
			logger.Info("Added fallback host: %s:%d", host.Host, host.Port)
		}
	}

	// If mDNS is disabled, return fallback hosts only
	if !config.UseMDNS {
		logger.Info("mDNS discovery disabled, using fallback hosts only")
		return hosts
	}

	// Perform mDNS discovery
	logger.Info("Starting mDNS discovery for 'strux-dev' service...")

	// Create resolver
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		logger.Warn("Failed to create mDNS resolver: %v", err)
		return hosts
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

	// Collect discovered services
	logger.Info("Waiting 5 seconds for mDNS discovery...")

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
					hosts = append(hosts, host)
					logger.Info("Found mDNS service: %s:%d", host.Host, host.Port)
					break
				}
			}
		case <-ctx.Done():
			logger.Info("Discovery complete: %d host(s) found", len(hosts))
			return hosts
		}
	}
}
