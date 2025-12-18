# Nubox PDF Downloader

Express server that downloads PDF files from Nubox ASP URLs using Puppeteer and returns them as base64 encoded strings.

## Features

- Downloads PDFs from ASP URLs that may redirect
- Handles browser-like navigation and redirects
- Returns PDF as base64 encoded string
- CORS enabled for cross-origin requests
- Health check endpoint

## Installation

```bash
npm install
```

## Usage

### Start the server

```bash
npm start
```

The server will run on port 3000 (or the port specified in the `PORT` environment variable).

### Download PDF

Make a GET request to the `/download-pdf` endpoint with the `url` query parameter:

```bash
curl "http://localhost:3000/download-pdf?url=https://example.com/asp-page"
```

### Response

On success, returns a JSON object with the base64 encoded PDF:

```json
{
  "success": true,
  "pdf": "base64-encoded-pdf-string",
  "contentType": "application/pdf",
  "filename": filename
}
```

On error, returns an error object:

```json
{
  "error": "Error message",
  "message": "Detailed error description"
}
```

## Endpoints

- `GET /` - API information
- `GET /health` - Health check
- `GET /download-pdf?url=<ASP_URL>` - Download PDF from URL

## Railway Deployment

This project is configured for Railway deployment. The server will automatically use the `PORT` environment variable provided by Railway.

## Dependencies

- express: Web framework
- puppeteer: Browser automation for handling redirects
- cors: Cross-origin resource sharing


