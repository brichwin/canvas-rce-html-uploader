# Canvas HTML Uploader (designed for uploading make4ht content)

Tool for inserting make4ht-generated HTML into Canvas Pages using a local server + bookmarklet.

## What this does

- Concatenates CSS in source order and inlines it into `style=""` attributes (Canvas RCE strips `<style>` blocks)
- Converts local image references to Canvas-hosted files via Canvas Files API
- Uploads images to a specified folder in Canvas course files (default: `latex_images`)
- Removes empty paragraphs from `.card` elements (cleanup for make4ht output)
- Server returns the body innerHTML of HTML documents
- Bookmarklet inserts or replaces the Canvas RCE content with the processed HTML

## Install

```bash
npm install
```

## Use

1. **Start the server** pointing to your make4ht output folder:
   ```bash
   node make4ht-content-server.js /path/to/make4ht/output
   ```

2. **Install the bookmarklet**:
   - Open http://127.0.0.1:3847 in your browser
   - Drag the "Upload to Canvas" link to your bookmarks bar

3. **Use in Canvas**:
   - Navigate to a Canvas page and click "Edit"
   - Ensure the Rich Content Editor (RCE) is visible
   - Click the bookmarklet
   - Select the HTML file from the list
   - Choose mode: `replace` (replace entire page) or `insert` (insert at cursor)
   - Enter a folder name for uploaded images (default: `latex_images`)
   - Images will be uploaded to Canvas and the HTML will be inserted

## How it works

### Server-side processing

- Reads HTML files from the make4ht output directory
- Collects all CSS from `<link>` and `<style>` tags in document order
- Uses `juice` to inline CSS into `style=""` attributes
- Removes empty last paragraphs in `.card` elements (including non-breaking spaces)
- Serves images from the make4ht output folder

### Client-side (bookmarklet)

- Fetches images and uploads to Canvas
- Updates image `src` attributes to Canvas URLs before inserting HTML
- Inserts processed HTML into TinyMCE editor

## Notes

- Images are uploaded **before** inserting HTML to ensure all URLs are correct
- CSS must be inlined because Canvas strips `<style>` blocks
- Remote CSS and images are ignored (not inlined)
