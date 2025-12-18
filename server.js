const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Browser singleton to avoid resource busy errors
let browserInstance = null;

// Function to get or create browser instance
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  // Create a unique user data directory to avoid locks
  const userDataDir = path.join(os.tmpdir(), `puppeteer-${Date.now()}-${Math.random().toString(36).substring(7)}`);

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  };

  // Windows-specific options
  if (process.platform === 'win32') {
    launchOptions.args.push(
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    );
    // Use a temp directory for user data on Windows
    launchOptions.userDataDir = userDataDir;
  }

  try {
    browserInstance = await puppeteer.launch(launchOptions);
    console.log('Browser instance created');
    return browserInstance;
  } catch (error) {
    console.error('Error launching browser:', error);
    // Retry once with different options
    if (!browserInstance) {
      try {
        browserInstance = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        return browserInstance;
      } catch (retryError) {
        throw new Error(`Failed to launch browser: ${retryError.message}`);
      }
    }
    throw error;
  }
}

// Cleanup function
async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
      browserInstance = null;
      console.log('Browser instance closed');
    } catch (error) {
      console.error('Error closing browser:', error);
      browserInstance = null;
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', closeBrowser);
process.on('SIGINT', closeBrowser);

// Helper function to delay (replacement for page.waitForTimeout)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to extract RUT and Fecha de Emisión from PDF
async function extractPdfMetadata(pdfBuffer) {
  try {
    const PDFParser = require('pdf2json');
    
    // Parse PDF using pdf2json
    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser(null, 1);
      
      pdfParser.on('pdfParser_dataError', (err) => {
        console.error('PDF parsing error:', err);
        resolve({ rut: null, fechaEmision: null });
      });
      
      pdfParser.on('pdfParser_dataReady', (pdfData) => {
        try {
          // Extract text from all pages
          let rawText = '';
          if (pdfData.Pages) {
            pdfData.Pages.forEach(page => {
              if (page.Texts) {
                page.Texts.forEach(textItem => {
                  if (textItem.R) {
                    textItem.R.forEach(run => {
                      if (run.T) {
                        // Decode URI-encoded text
                        rawText += decodeURIComponent(run.T) + ' ';
                      }
                    });
                  }
                });
              }
            });
          }
          
          // Normalize text: PDF extraction adds spaces between every character
          // Strategy: Remove ALL spaces and search for patterns without spaces
          // This works because patterns like "RUT" and "4.835.956-6" are still recognizable
          const textNoSpaces = rawText.replace(/\s+/g, '');
          // Also keep a version with normalized spacing for date extraction
          let text = rawText
            .replace(/\s+/g, ' ')
            .replace(/([A-Z])\s+([A-Z])/g, '$1$2')
            .replace(/(\d)\s+([\.-])\s*(\d)/g, '$1$2$3')
            .replace(/(\d)\s+(\d)/g, '$1$2')
            .replace(/([a-z])\s+([a-z])/g, '$1$2')
            .replace(/\s+/g, ' ')
            .trim();
          
          console.log('Text without spaces (first 500 chars):', textNoSpaces.substring(0, 500));
          
          // Extract RUT - look for client RUT in table context
          // The client RUT appears as "RUT | 4.835.956-6" in the table row
          // RUT format: digits with dots and dash (e.g., 4.835.956-6)
          let rut = null;
          
          // Search in text without spaces: "RUT" followed by number pattern
          // Pattern: RUT followed by digits, dots, dash, and final digit
          const rutPatternNoSpaces = /RUT[|:]?(\d+\.\d+\.\d+-\d)/i;
          const tableRutMatch = textNoSpaces.match(rutPatternNoSpaces);
          if (tableRutMatch) {
            rut = tableRutMatch[1].replace(/\./g, '').replace(/-/g, '');
            console.log(`Extracted client RUT from table: ${tableRutMatch[1]} -> ${rut}`);
          } else {
            // Fallback: find all RUT patterns in text without spaces
            const allRutMatches = [...textNoSpaces.matchAll(/RUT[|:]?(\d+\.\d+\.\d+-\d)/gi)];
            if (allRutMatches.length > 0) {
              // If multiple RUTs found, prefer one that appears after "Señor" or "Señor(es)"
              const senoresIndex = textNoSpaces.toLowerCase().indexOf('señor');
              let selectedRut = null;
              let minDistance = Infinity;
              
              for (const match of allRutMatches) {
                const rutIndex = match.index;
                if (senoresIndex >= 0 && rutIndex > senoresIndex) {
                  const distance = rutIndex - senoresIndex;
                  if (distance < minDistance) {
                    minDistance = distance;
                    selectedRut = match[1];
                  }
                }
              }
              
              // If no RUT found after "Señor", use the last one (likely client RUT in table)
              if (!selectedRut && allRutMatches.length > 1) {
                selectedRut = allRutMatches[allRutMatches.length - 1][1];
              } else if (!selectedRut) {
                selectedRut = allRutMatches[0][1];
              }
              
              if (selectedRut) {
                rut = selectedRut.replace(/\./g, '').replace(/-/g, '');
                console.log(`Extracted RUT (fallback): ${selectedRut} -> ${rut}`);
              }
            }
          }
          
          // Extract Fecha de Emisión - look for pattern like "Fecha Emisión | 15 de diciembre de 2025"
          // Date format: "DD de MMMM de YYYY" (e.g., "15 de diciembre de 2025")
          // Try both normalized text and text without spaces
          let dateMatch = text.match(/FechaEmisi[óo]n[:\s|]*(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
          if (!dateMatch) {
            // Try without spaces: "FechaEmisión15dediciembrede2025"
            // Use a more flexible pattern that handles the ó character and any characters between
            dateMatch = textNoSpaces.match(/Fecha.*?(\d{1,2})de(\w+)de(\d{4})/i);
          }
          
          let fechaEmision = null;
          if (dateMatch) {
            const day = dateMatch[1].padStart(2, '0');
            // Handle both spaced and non-spaced month names
            const monthNameRaw = dateMatch[2];
            const monthName = monthNameRaw.toLowerCase().replace(/\s+/g, '');
            const year = dateMatch[3];
            
            // Map Spanish month names to numbers
            const monthMap = {
              'enero': '01', 'febrero': '02', 'marzo': '03', 'abril': '04',
              'mayo': '05', 'junio': '06', 'julio': '07', 'agosto': '08',
              'septiembre': '09', 'octubre': '10', 'noviembre': '11', 'diciembre': '12'
            };
            
            const month = monthMap[monthName] || '01';
            fechaEmision = `${year}-${month}-${day}`;
            console.log(`Extracted Fecha de Emisión: ${dateMatch[0]} -> ${fechaEmision}`);
          }
          
          resolve({ rut, fechaEmision });
        } catch (error) {
          console.error('Error processing PDF data:', error.message);
          resolve({ rut: null, fechaEmision: null });
        }
      });
      
      // Parse the PDF buffer
      pdfParser.parseBuffer(pdfBuffer);
    });
  } catch (error) {
    console.error('Error extracting PDF metadata:', error.message);
    return { rut: null, fechaEmision: null };
  }
}

// Helper function to generate PDF filename from metadata
// Note: File saving is skipped in production (Railway) - filename is returned for Google Apps Script
async function generatePdfFilename(pdfBuffer, url) {
  try {
    // Extract metadata from PDF
    const { rut, fechaEmision } = await extractPdfMetadata(pdfBuffer);
    
    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const urlHash = Buffer.from(url).toString('base64').substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
    
    let filename;
    if (rut && fechaEmision) {
      // Format: {rut}-{fechaemision}-${timestamp}-${urlHash}.pdf
      filename = `${rut}-${fechaEmision}-${timestamp}-${urlHash}.pdf`;
    } else {
      // Fallback to old format if extraction fails
      filename = `pdf-${timestamp}-${urlHash}.pdf`;
      if (!rut) console.log('Warning: Could not extract RUT from PDF');
      if (!fechaEmision) console.log('Warning: Could not extract Fecha de Emisión from PDF');
    }
    
    // Optionally save file locally for testing (only if SAVE_PDF_FILES env var is set)
    if (process.env.SAVE_PDF_FILES === 'true') {
      try {
        const downloadsDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(downloadsDir)) {
          fs.mkdirSync(downloadsDir, { recursive: true });
        }
        const filepath = path.join(downloadsDir, filename);
        fs.writeFileSync(filepath, pdfBuffer);
        console.log(`PDF saved to: ${filepath}`);
      } catch (saveError) {
        console.log('Note: Could not save PDF file locally (this is normal in production)');
      }
    }
    
    console.log(`Generated filename: ${filename}`);
    return filename;
  } catch (error) {
    console.error('Error generating PDF filename:', error.message);
    // Return a fallback filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const urlHash = Buffer.from(url).toString('base64').substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
    return `pdf-${timestamp}-${urlHash}.pdf`;
  }
}

// GET endpoint to download PDF from ASP URL
app.get('/download-pdf', async (req, res) => {
  let page = null;
  try {
    const { url } = req.query;

    // Validate URL parameter
    if (!url) {
      return res.status(400).json({
        error: 'Missing required parameter: url',
        message: 'Please provide a URL query parameter'
      });
    }

    // Validate URL format
    let targetUrl;
    try {
      targetUrl = new URL(url);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid URL format',
        message: 'Please provide a valid URL'
      });
    }

    console.log(`Starting PDF download from: ${url}`);

    // Get browser instance
    const browser = await getBrowser();
    
    // Create a new page
    page = await browser.newPage();

    // Set a reasonable timeout
    page.setDefaultTimeout(60000);

    // Variable to store PDF buffer
    let pdfBuffer = null;
    let pdfCaptured = false;
    const requestIdMap = new Map(); // Map to store request IDs for CDP
    let cdpClient = null;

    // Enable CDP Network domain to track requests
    try {
      cdpClient = await page.target().createCDPSession();
      await cdpClient.send('Network.enable');
      console.log('CDP Network domain enabled');
    } catch (error) {
      console.log('Could not enable CDP Network domain:', error.message);
    }

    // Track responses via CDP Network events
    // Store response info for later retrieval
    const cdpResponseMap = new Map(); // Map requestId -> response info
    
    if (cdpClient) {
      cdpClient.on('Network.responseReceived', async (event) => {
        if (pdfCaptured) return;
        
        const response = event.response;
        const contentType = response.headers['content-type'] || '';
        const responseUrl = response.url;
        const status = response.status;
        const requestId = event.requestId;
        
        // Store response info for later retrieval
        cdpResponseMap.set(requestId, {
          url: responseUrl,
          contentType: contentType,
          status: status,
          mimeType: response.mimeType
        });
        
        console.log(`CDP Response [${status}]: ${responseUrl.substring(0, 100)}..., Content-Type: ${contentType}, RequestId: ${requestId}`);
        
        // Check for PDF responses (POST or GET)
        if (contentType.includes('application/pdf') || response.mimeType === 'application/pdf') {
          console.log(`CDP detected PDF response: ${responseUrl}, RequestId: ${requestId}`);
          // Don't try to get body immediately - wait for loadingFinished
        }
      });
      
      // Track request finished events to catch POST responses
      // This is where we can reliably get the response body
      cdpClient.on('Network.loadingFinished', async (event) => {
        if (pdfCaptured) return;
        
        const requestId = event.requestId;
        const responseInfo = cdpResponseMap.get(requestId);
        
        if (!responseInfo) {
          return; // Not a response we're tracking
        }
        
        const contentType = responseInfo.contentType || '';
        const responseUrl = responseInfo.url;
        
        // Check if this is a PDF response
        if (contentType.includes('application/pdf') || responseInfo.mimeType === 'application/pdf') {
          console.log(`CDP loadingFinished for PDF: ${responseUrl}, RequestId: ${requestId}`);
          
          try {
            // Wait a bit for the response body to be fully available
            await delay(300);
            
            const { body, base64Encoded } = await cdpClient.send('Network.getResponseBody', {
              requestId: requestId
            });
            
            if (body) {
              const buffer = base64Encoded 
                ? Buffer.from(body, 'base64') 
                : Buffer.from(body, 'utf8');
              
              const header = buffer.slice(0, 4).toString();
              console.log(`CDP PDF buffer size: ${buffer.length} bytes, header: ${header}`);
              
              if (header === '%PDF') {
                pdfBuffer = buffer;
                pdfCaptured = true;
                console.log(`✓ PDF buffer captured via CDP loadingFinished: ${buffer.length} bytes`);
              } else {
                console.log(`CDP: Response claims to be PDF but header doesn't match: ${header} (first 50: ${buffer.slice(0, 50).toString()})`);
              }
            } else {
              console.log('CDP: Response body is empty');
            }
          } catch (error) {
            console.log(`CDP loadingFinished handler error: ${error.message}`);
            // Retry after a longer delay
            try {
              await delay(1000);
              const { body, base64Encoded } = await cdpClient.send('Network.getResponseBody', {
                requestId: requestId
              });
              
              if (body) {
                const buffer = base64Encoded 
                  ? Buffer.from(body, 'base64') 
                  : Buffer.from(body, 'utf8');
                
                const header = buffer.slice(0, 4).toString();
                if (header === '%PDF') {
                  pdfBuffer = buffer;
                  pdfCaptured = true;
                  console.log(`✓ PDF buffer captured via CDP (retry): ${buffer.length} bytes`);
                }
              }
            } catch (retryError) {
              console.log(`CDP retry also failed: ${retryError.message}`);
            }
          }
        }
      });
    }

    // Intercept requests to store request IDs for CDP access
    page.on('request', (request) => {
      const url = request.url();
      const method = request.method();
      const requestId = request._requestId;
      
      // Log POST requests (form submissions)
      if (method === 'POST') {
        console.log(`POST request detected: ${url.substring(0, 100)}...`);
      }
      
      if (requestId) {
        requestIdMap.set(url, requestId);
      }
    });

    // Intercept responses to catch PDF downloads
    page.on('response', async (response) => {
      if (pdfCaptured) return; // Already captured, skip
      
      const contentType = response.headers()['content-type'] || '';
      const responseUrl = response.url();
      const status = response.status();
      
      // Log all responses for debugging
      console.log(`Response [${status}]: ${responseUrl.substring(0, 100)}..., Content-Type: ${contentType}`);
      
      // Check if content-type indicates PDF, or if URL suggests PDF
      const isPdfContentType = contentType.includes('application/pdf');
      const isPdfUrl = responseUrl.toLowerCase().includes('.pdf') || responseUrl.toLowerCase().includes('pdf');
      
      // Check responses that might be PDFs (by content-type or URL pattern)
      if (isPdfContentType || isPdfUrl || status === 200) {
        try {
          // Try to get the buffer from the response
          let buffer = await response.buffer().catch(async (err) => {
            console.log(`Could not get buffer for ${responseUrl}: ${err.message}`);
            
            // If buffer() fails, try using CDP (Chrome DevTools Protocol)
            if (isPdfContentType) {
              try {
                console.log(`Attempting to get PDF via CDP for ${responseUrl}`);
                const client = await page.target().createCDPSession();
                
                // Try multiple ways to get the request ID
                let requestId = response.request()._requestId || response._requestId;
                
                // If not found, try to get it from our map
                if (!requestId) {
                  requestId = requestIdMap.get(responseUrl);
                }
                
                // If still not found, try to get it from the request object
                if (!requestId) {
                  const request = response.request();
                  requestId = request._requestId || request._interceptionId;
                }
                
                console.log(`CDP Request ID: ${requestId}`);
                
                if (requestId) {
                  const { body, base64Encoded } = await client.send('Network.getResponseBody', {
                    requestId: requestId
                  });
                  
                  if (body) {
                    console.log(`CDP success! Body length: ${body.length}, base64Encoded: ${base64Encoded}`);
                    if (base64Encoded) {
                      return Buffer.from(body, 'base64');
                    } else {
                      return Buffer.from(body, 'utf8');
                    }
                  } else {
                    console.log('CDP returned empty body');
                  }
                } else {
                  console.log('Could not find request ID for CDP');
                }
              } catch (cdpError) {
                console.log(`CDP method failed: ${cdpError.message}`);
              }
            }
            
            return null;
          });
          
          if (buffer && buffer.length > 0) {
            // Verify it's actually a PDF by checking the magic bytes
            // PDF files start with %PDF
            const header = buffer.slice(0, 4).toString();
            if (header === '%PDF') {
              pdfBuffer = buffer;
              pdfCaptured = true;
              console.log(`✓ PDF buffer captured from ${responseUrl}: ${buffer.length} bytes`);
            } else if (isPdfContentType) {
              // Content-type says PDF but magic bytes don't match
              console.log(`⚠ Response claims to be PDF but header is: ${header} (first 50 chars: ${buffer.slice(0, 50).toString()})`);
            }
          }
        } catch (error) {
          console.log(`Error processing response ${responseUrl}:`, error.message);
          // If all methods fail, try to fetch the URL directly from page context
          if (isPdfContentType) {
            try {
              console.log(`Attempting to fetch PDF via page.evaluate for ${responseUrl}`);
              const fetchResponse = await page.evaluate(async (pdfUrl) => {
                const response = await fetch(pdfUrl);
                const arrayBuffer = await response.arrayBuffer();
                return Array.from(new Uint8Array(arrayBuffer));
              }, responseUrl);
              
              if (fetchResponse && fetchResponse.length > 0) {
                const buffer = Buffer.from(fetchResponse);
                // Verify it's actually a PDF
                const header = buffer.slice(0, 4).toString();
                if (header === '%PDF') {
                  pdfBuffer = buffer;
                  pdfCaptured = true;
                  console.log(`✓ PDF buffer captured via fetch: ${pdfBuffer.length} bytes`);
                }
              }
            } catch (fetchError) {
              console.log('Fetch method also failed:', fetchError.message);
            }
          }
        }
      }
    });

    // Navigate to the URL
    // First, load the page (it may contain a form that auto-submits)
    console.log('Navigating to URL...');
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }).catch(async (error) => {
      console.log('Initial navigation error:', error.message);
      return null;
    });

    console.log('Page loaded, waiting for form submission and PDF response...');

    // Wait for the form to submit and POST response
    // The page has JavaScript that auto-submits a form via POST
    try {
      // Wait for navigation after form submission (up to 30 seconds)
      // This will catch the POST response
      await page.waitForNavigation({ 
        waitUntil: 'networkidle0', 
        timeout: 30000 
      });
      console.log('Navigation after form submission detected');
    } catch (error) {
      console.log('Navigation wait timed out or form already submitted:', error.message);
    }

    // Wait for PDF to be captured (POST response might take a moment)
    // Check every 500ms for up to 40 seconds after navigation
    console.log('Waiting for PDF response (POST)...');
    for (let i = 0; i < 80 && !pdfCaptured; i++) {
      await delay(500);
      if (pdfBuffer && pdfBuffer.length > 0) {
        pdfCaptured = true;
        console.log('PDF captured in waiting loop');
        break;
      }
    }
    
    // If still not captured, wait for network to be completely idle
    // POST responses might still be loading
    if (!pdfCaptured) {
      console.log('PDF not captured yet, waiting for network idle (POST response)...');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {});
        await delay(3000); // Give extra time for POST response body to be available
      } catch (error) {
        console.log('Network idle wait completed or timed out');
      }
      
      // Check one more time after waiting
      if (pdfBuffer && pdfBuffer.length > 0) {
        pdfCaptured = true;
        console.log('PDF found after network idle wait');
      }
    }
    
    // Final check - wait a bit more for CDP to finish processing
    if (!pdfCaptured) {
      console.log('Final wait for CDP to capture PDF...');
      await delay(2000);
      if (pdfBuffer && pdfBuffer.length > 0) {
        pdfCaptured = true;
        console.log('PDF found in final check');
      }
    }

    // Check if we captured a PDF buffer from response interception
    if (pdfBuffer && pdfBuffer.length > 0) {
      const base64Pdf = pdfBuffer.toString('base64');
      
      // Generate filename for Google Apps Script
      const filename = await generatePdfFilename(pdfBuffer, url);
      
      if (page) {
        await page.close().catch(err => console.error('Error closing page:', err));
      }
      
      return res.json({
        success: true,
        pdf: base64Pdf,
        contentType: 'application/pdf',
        filename: filename
      });
    }

    // Try to get PDF from the response if it's a PDF
    if (response && !pdfCaptured) {
      const contentType = response.headers()['content-type'] || '';
      
      if (contentType.includes('application/pdf')) {
        try {
          // Try to get the buffer
          const buffer = await response.buffer();
          
          // Verify it's actually a PDF by checking the magic bytes
          if (buffer && buffer.length > 0) {
            const header = buffer.slice(0, 4).toString();
            if (header === '%PDF') {
              const base64Pdf = buffer.toString('base64');
              
              // Generate filename for Google Apps Script
              const filename = await generatePdfFilename(buffer, url);
              
              if (page) {
                await page.close().catch(err => console.error('Error closing page:', err));
              }
              
              return res.json({
                success: true,
                pdf: base64Pdf,
                contentType: 'application/pdf',
                filename: filename
              });
            } else {
              console.log('Response claims to be PDF but header is:', header);
            }
          }
        } catch (error) {
          console.log('Error getting PDF from response:', error.message);
        }
      }
    }

    // Check current URL - if it's different, try to fetch it directly
    const currentUrl = page.url();
    console.log(`Final page URL: ${currentUrl}`);
    console.log(`Original URL: ${url}`);
    
    // If the URL changed, try fetching directly using page.evaluate (browser fetch)
    if (currentUrl !== url && !pdfCaptured) {
      console.log('URL changed, attempting to fetch the new URL directly via browser fetch...');
      try {
        // First, try to get form data and submit it
        const formData = await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) {
            const data = {};
            
            // Get all form inputs (including hidden fields)
            const inputs = form.querySelectorAll('input, textarea, select');
            inputs.forEach(input => {
              const name = input.name;
              const type = input.type;
              const value = input.value;
              
              if (name) {
                // Handle checkboxes and radios
                if (type === 'checkbox' || type === 'radio') {
                  if (input.checked) {
                    data[name] = value || 'on';
                  }
                } else {
                  data[name] = value || '';
                }
              }
            });
            
            return {
              action: form.action || window.location.href,
              method: (form.method || 'POST').toUpperCase(),
              data: data
            };
          }
          return null;
        });
        
        if (formData) {
          console.log(`Form found: ${formData.method} ${formData.action}, fields: ${Object.keys(formData.data).join(', ')}`);
        }
        
        // Use page.evaluate to fetch from browser context (handles cookies/auth)
        const fetchResponse = await page.evaluate(async (pdfUrl, formInfo) => {
          try {
            let response;
            
            // If we have form data, submit it as application/x-www-form-urlencoded
            if (formInfo && formInfo.data) {
              console.log('Submitting form with data:', Object.keys(formInfo.data));
              
              // Build URL-encoded form data string
              const formBody = Object.keys(formInfo.data)
                .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(formInfo.data[key]))
                .join('&');
              
              response = await fetch(formInfo.action || pdfUrl, {
                method: formInfo.method || 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Accept': 'application/pdf,application/octet-stream,*/*'
                },
                body: formBody,
                credentials: 'include'
              });
            } else {
              // Try GET first
              response = await fetch(pdfUrl, {
                method: 'GET',
                headers: {
                  'Accept': 'application/pdf,application/octet-stream,*/*'
                },
                credentials: 'include'
              });
            }
            
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            
            const contentType = response.headers.get('content-type') || '';
            console.log('Fetch response content-type:', contentType);
            
            const arrayBuffer = await response.arrayBuffer();
            return {
              data: Array.from(new Uint8Array(arrayBuffer)),
              contentType: contentType
            };
          } catch (error) {
            console.error('Fetch error in page context:', error);
            return null;
          }
        }, currentUrl, formData);
        
        if (fetchResponse && fetchResponse.data && fetchResponse.data.length > 0) {
          const buffer = Buffer.from(fetchResponse.data);
          // Verify it's actually a PDF
          const header = buffer.slice(0, 4).toString();
          console.log(`Direct fetch buffer header: ${header}, size: ${buffer.length} bytes, content-type: ${fetchResponse.contentType}`);
          
          if (header === '%PDF' || fetchResponse.contentType.includes('application/pdf')) {
            // Double check it's actually a PDF
            if (header === '%PDF') {
              const base64Pdf = buffer.toString('base64');
              
              // Generate filename for Google Apps Script
              const filename = await generatePdfFilename(buffer, url);
              
              if (page) {
                await page.close().catch(err => console.error('Error closing page:', err));
              }
              
              return res.json({
                success: true,
                pdf: base64Pdf,
                contentType: 'application/pdf',
                filename: filename
              });
            } else {
              console.log(`Content-type says PDF but header doesn't match: ${header}`);
            }
          } else {
            console.log(`Direct fetch did not return PDF. Header: ${header}, Content-Type: ${fetchResponse.contentType}`);
          }
        }
      } catch (error) {
        console.log('Error fetching direct URL via browser fetch:', error.message);
        
        // Fallback: Try with a new page navigation
        try {
          console.log('Trying fallback: new page navigation...');
          const newPage = await browser.newPage();
          const directResponse = await newPage.goto(currentUrl, {
            waitUntil: 'networkidle0',
            timeout: 30000
          });
          
          if (directResponse) {
            const contentType = directResponse.headers()['content-type'] || '';
            console.log(`Fallback fetch Content-Type: ${contentType}`);
            
            const buffer = await directResponse.buffer().catch(async (err) => {
              // If buffer fails, try CDP
              try {
                const client = await newPage.target().createCDPSession();
                const requestId = directResponse.request()._requestId;
                if (requestId) {
                  const { body, base64Encoded } = await client.send('Network.getResponseBody', {
                    requestId: requestId
                  });
                  if (body) {
                    return base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
                  }
                }
              } catch (cdpErr) {
                console.log('CDP fallback failed:', cdpErr.message);
              }
              return null;
            });
            
            if (buffer && buffer.length > 0) {
              const header = buffer.slice(0, 4).toString();
              if (header === '%PDF') {
                const base64Pdf = buffer.toString('base64');
                const filename = await generatePdfFilename(buffer, url);
                
                await newPage.close().catch(() => {});
                if (page) {
                  await page.close().catch(err => console.error('Error closing page:', err));
                }
                
                return res.json({
                  success: true,
                  pdf: base64Pdf,
                  contentType: 'application/pdf',
                  filename: filename
                });
              }
            }
          }
          await newPage.close().catch(() => {});
        } catch (fallbackError) {
          console.log('Fallback navigation also failed:', fallbackError.message);
        }
      }
    }

    // Last resort: If no PDF was found, return error
    if (page) {
      await page.close().catch(err => console.error('Error closing page:', err));
    }
    
    throw new Error('No PDF found. The URL may not redirect to a PDF file, or the PDF download failed.');

  } catch (error) {
    // Close page on error
    if (page) {
      try {
        await page.close();
      } catch (closeError) {
        console.error('Error closing page on error:', closeError);
      }
    }
    
    console.error('Error downloading PDF:', error);
    res.status(500).json({
      error: 'Failed to download PDF',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'PDF Downloader API',
    endpoints: {
      'GET /download-pdf?url=<ASP_URL>': 'Download PDF from ASP URL and return as base64',
      'GET /health': 'Health check endpoint'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

