# Delivery workflow

After local verification succeeds for requested changes in this repository:

1. Commit the related changes and push the PR branch.
2. Create or update the PR and retrieve its Cloudflare preview URL.
3. Confirm the preview comment names the pushed commit, then return the affected page's preview link.

Unless the user asks to keep work local, a localhost preview alone is not the completed delivery.
