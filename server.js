const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const xlsx = require('xlsx');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper function to call Ollama API
async function callOllama(prompt, model = 'qwen3:latest') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: model,
      prompt: prompt,
      stream: false
    });

    const options = {
      hostname: 'localhost',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(responseData);
          resolve(jsonResponse.response);
        } catch (error) {
          reject(new Error('Failed to parse Ollama response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error('Failed to connect to Ollama: ' + error.message));
    });

    req.write(data);
    req.end();
  });
}

// Route: Upload and process file (streaming for Excel)
app.post('/api/process', upload.single('file'), async (req, res) => {
  try {
    const processingType = req.body.processingType || 'custom';
    const customPrompt = req.body.customPrompt || '';

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.xlsx' || ext === '.xls') {
        // For Excel, process normally
        return processExcel(req, res);
      } else {
        // For other files, process normally
        const inputText = fs.readFileSync(req.file.path, 'utf-8');
        fs.unlinkSync(req.file.path);

        let fullPrompt = '';
        switch (processingType) {
          case 'custom':
            fullPrompt = `${customPrompt}\n\n${inputText}`;
            break;
          default:
            fullPrompt = inputText;
        }

        const result = await callOllama(fullPrompt);
        res.json({
          success: true,
          result: result,
          inputLength: inputText.length
        });
      }
    } else if (req.body.text) {
      const inputText = req.body.text;

      let fullPrompt = '';
      switch (processingType) {
        case 'custom':
          fullPrompt = `${customPrompt}\n\n${inputText}`;
          break;
        default:
          fullPrompt = inputText;
      }

      const result = await callOllama(fullPrompt);
      res.json({
        success: true,
        result: result,
        inputLength: inputText.length
      });
    } else {
      return res.status(400).json({ error: 'No file or text provided' });
    }

  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({
      error: error.message || 'Failed to process data'
    });
  }
});

// Excel processing
async function processExcel(req, res) {
  try {
    const uploadedPath = req.file.path;
    const originalName = req.file.originalname;

    // Read Excel file and convert to JSON
    const workbook = xlsx.readFile(uploadedPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

    const processingType = req.body.processingType || 'custom';
    const customPrompt = req.body.customPrompt || '';

    let modelPrompt = '';
    if (processingType === 'voc') {
      modelPrompt = `You are a data-cleaning assistant for Problem analysis reported by Customer.
You will be given a JSON array of rows. Each row has fields "Title" and "Problem" (and may include Case Code or Model No.).
For each row produce an object with exactly these keys: "Module", "Summarized Problem", "Severity".
- Remove ALL tokens inside square brackets [] before summarizing.
- Translate non-English text to English.
- Summarized Problem must be one concise English sentence merging Title and Problem.
- Severity must be one of: Critical, High, Medium, Low.

Rules:
1) Return ONLY a single valid JSON array of objects in the same order as input.
2) Each object must contain EXACT keys: "Module", "Summarized Problem", "Severity".
3) No commentary or extra fields.
4) Output excel file's column sequence sould be "Case Code", "Model NO.", "Title", "Problem", "Module", "Summarized Problem", "Severity".

Input:
${JSON.stringify(rows, null, 2)}

Return only the JSON array.`;
    } else {
      modelPrompt = `${customPrompt}\n\n${JSON.stringify(rows, null, 2)}`;
    }

    // Send to AI model
    const modelResult = await callOllama(modelPrompt);

    // Parse AI response back to JSON
    let modelText = modelResult.trim();
    const firstBracket = modelText.indexOf('[');
    const lastBracket = modelText.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      modelText = modelText.substring(firstBracket, lastBracket + 1);
    }

    const parsed = JSON.parse(modelText);

    // Merge original data with AI results
    const merged = rows.map((r, i) => {
      const ai = parsed[i] || {};
      return {
        ...r,
        Module: ai.Module || '',
        'Summarized Problem': ai['Summarized Problem'] || ai.SummarizedProblem || '',
        Severity: ai.Severity || ''
      };
    });

    // Convert merged JSON back to Excel
    const newWb = xlsx.utils.book_new();
    const newSheet = xlsx.utils.json_to_sheet(merged);
    xlsx.utils.book_append_sheet(newWb, newSheet, 'Data');
    const buf = xlsx.write(newWb, { bookType: 'xlsx', type: 'buffer' });

    // Save to file
    const processedFilename = `processed-${Date.now()}-${originalName}`;
    const processedPath = path.join('downloads', processedFilename);
    fs.writeFileSync(processedPath, buf);

    fs.unlinkSync(uploadedPath);

    res.json({
      success: true,
      downloadUrl: `/downloads/${processedFilename}`,
      filename: processedFilename
    });
  } catch (error) {
    console.error('Excel processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Processing failed'
    });
  }
}



// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ollama: 'connected' });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Ollama Web Processor is running!`);
  console.log(`📍 Open your browser and go to: http://localhost:${PORT}`);
  console.log(`🤖 Make sure Ollama is running with qwen3:latest model\n`);
});
