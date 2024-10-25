# Changelog

## [2024-03-19]

- Cleaned up dependencies:
  - Removed unused packages: @playform/compress, astro-page-insight, teller-connect-react
  - Trusted @sentry/cli postinstall script for proper error monitoring setup
- Added custom scrollbar to blog card descriptions:
  - Implemented thin, minimal scrollbar design
  - Added smooth scrollbar transitions
  - Styled scrollbar for both light and dark themes
  - Limited description height to 150px with overflow scroll
- Enhanced blog card animations:
  - Increased hover elevation to 24px for more dramatic effect
  - Enlarged scale transform to 1.08 for better visibility
  - Improved shadow depth with 60px spread and higher opacity
  - Increased z-index to 20 for proper card overlapping
  - Replaced overlay-based description expansion with smooth max-height transition
  - Extended animation duration to 0.6s for smoother effect
- Optimized GitHub Actions workflow:
  - Migrated to wrangler-action@v3 from deprecated pages-action
  - Added proper Bun dependency caching
  - Improved environment variable handling
  - Streamlined deployment process with better error handling
  - Added branch-specific deployment triggers
  - Renamed workflow file to cloudflare-pages-deploy.yml for better clarity
- Redesigned blog card hover animations:
  - Added prominent floating effect with 16px elevation
  - Enhanced shadow animation for depth perception
  - Implemented smooth cubic-bezier transitions
  - Improved dark mode shadow handling
  - Optimized animation timing (0.5s duration)
- Added Notion CMS integration using @notionhq/client with proper type safety
- Created blog pages with TypeScript support
- Added blog navigation link to header
- Implemented static page generation from Notion content
- Added support for various Notion block types:
  - Paragraphs with rich text formatting
  - Headings (H1, H2, H3)
  - Lists (bulleted and numbered)
  - Code blocks with language support
  - Images with captions
  - Quotes and dividers
  - Links and text formatting
- Fixed title extraction from Notion pages
- Updated description to use first text block from page content
- Improved card design with consistent sizing
- Made blog post cards fully clickable with enhanced hover states
- Added proper TypeScript interfaces for blog posts and pages
- Improved error handling for missing properties

## Initial Release

- Base project setup
