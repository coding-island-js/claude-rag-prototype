// API URL - auto-detects environment
const API_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:3000'
  : ''; // Will use same domain in production

// State
let documents = [];
let loadAllResult = null;
let smartResult = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadDocuments();
  updateBudget();
  
  // File upload handler
  document.getElementById('fileInput').addEventListener('change', handleFileUpload);
});

// File upload handler
async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const formData = new FormData();
  formData.append('file', file);
  
  try {
    const response = await fetch(`${API_URL}/upload`, {
      method: 'POST',
      body: formData
    });
    
    const result = await response.json();
    
    if (result.success) {
      await loadDocuments();
      e.target.value = ''; // Reset input
    } else {
      alert('Upload failed: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    alert('Upload failed: ' + error.message);
  }
}

// Load documents list
async function loadDocuments() {
  try {
    const response = await fetch(`${API_URL}/documents`);
    const data = await response.json();
    documents = data.documents;
    renderDocuments();
    updateBudget();
  } catch (error) {
    console.error('Failed to load documents:', error);
  }
}

// Render document list
function renderDocuments() {
  const list = document.getElementById('documentList');
  const countSpan = document.getElementById('docCount');
  
  countSpan.textContent = documents.length;
  
  if (documents.length === 0) {
    list.innerHTML = '<li class="empty-state">No documents uploaded yet</li>';
    return;
  }
  
  list.innerHTML = documents.map(doc => `
    <li class="document-item">
      <div>
        <span class="doc-name">${doc.filename}</span>
        <span class="doc-size">(${(doc.size / 1000).toFixed(1)}KB)</span>
      </div>
    </li>
  `).join('');
}

// Ask question
async function askQuestion(mode) {
  const question = document.getElementById('questionInput').value.trim();
  
  if (!question) {
    alert('Please enter a question');
    return;
  }
  
  if (documents.length === 0) {
    alert('Please upload at least one document first');
    return;
  }
  
  const btnLoadAll = document.getElementById('btnLoadAll');
  const btnSmart = document.getElementById('btnSmart');
  
  // Disable buttons
  btnLoadAll.disabled = true;
  btnSmart.disabled = true;
  
  if (mode === 'all') {
    btnLoadAll.textContent = '⏳ Processing...';
  } else {
    btnSmart.textContent = '⏳ Processing...';
  }
  
  try {
    const endpoint = mode === 'all' ? '/query-all' : '/query-smart';
    
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    
    const result = await response.json();
    
    if (response.status === 429) {
      alert(result.error);
      return;
    }
    
    // Store results
    if (mode === 'all') {
      loadAllResult = result;
    } else {
      smartResult = result;
    }
    
    // Display results
    displayResults();
    updateBudget();
    
  } catch (error) {
    alert('Query failed: ' + error.message);
  } finally {
    // Re-enable buttons
    btnLoadAll.disabled = false;
    btnSmart.disabled = false;
    btnLoadAll.textContent = '⚠️ Load All Docs';
    btnSmart.textContent = '✨ Smart Retrieval';
  }
}

// Display results
function displayResults() {
  const resultsSection = document.getElementById('resultsSection');
  resultsSection.style.display = 'block';
  
  // Show Load All results
  if (loadAllResult) {
    const card = document.getElementById('loadAllResults');
    card.style.display = 'block';
    
    document.getElementById('answerLoadAll').textContent = loadAllResult.answer;
    document.getElementById('docsLoadAll').textContent = loadAllResult.docsLoaded;
    document.getElementById('tokensLoadAll').textContent = loadAllResult.usage.input_tokens.toLocaleString();
    document.getElementById('costLoadAll').textContent = '$' + loadAllResult.cost.toFixed(4);
    document.getElementById('timeLoadAll').textContent = (loadAllResult.responseTime / 1000).toFixed(2) + 's';
  }
  
  // Show Smart results
  if (smartResult) {
    const card = document.getElementById('smartResults');
    card.style.display = 'block';
    
    document.getElementById('answerSmart').textContent = smartResult.answer;
    document.getElementById('docsSmart').textContent = smartResult.docsLoaded;
    document.getElementById('tokensSmart').textContent = smartResult.usage.input_tokens.toLocaleString();
    document.getElementById('costSmart').textContent = '$' + smartResult.cost.toFixed(4);
    document.getElementById('timeSmart').textContent = (smartResult.responseTime / 1000).toFixed(2) + 's';
    
    // Cache info
    const cacheInfo = document.getElementById('cacheInfo');
    const cacheDetails = document.getElementById('cacheDetails');
    
    if (smartResult.cacheStats.cacheCreationTokens > 0 || smartResult.cacheStats.cacheReadTokens > 0) {
      cacheInfo.style.display = 'block';
      cacheDetails.textContent = `Created: ${smartResult.cacheStats.cacheCreationTokens.toLocaleString()} | Read: ${smartResult.cacheStats.cacheReadTokens.toLocaleString()}`;
    }
    
    // Selected docs
    const selectedDocs = document.getElementById('selectedDocs');
    const selectedDocsList = document.getElementById('selectedDocsList');
    
    if (smartResult.selectedDocs && smartResult.selectedDocs.length > 0) {
      selectedDocs.style.display = 'block';
      selectedDocsList.textContent = smartResult.selectedDocs.map(d => d.filename).join(', ');
    }
  }
  
  // Show comparison if both results exist
  if (loadAllResult && smartResult) {
    showComparison();
  }
}

// Show comparison
function showComparison() {
  const summary = document.getElementById('comparisonSummary');
  summary.style.display = 'block';
  
  const tokenReduction = ((1 - (smartResult.usage.input_tokens / loadAllResult.usage.input_tokens)) * 100).toFixed(1);
  const costSavings = ((1 - (smartResult.cost / loadAllResult.cost)) * 100).toFixed(1);
  const speedImprovement = ((loadAllResult.responseTime / smartResult.responseTime)).toFixed(1);
  
  document.getElementById('tokenReduction').textContent = tokenReduction + '% fewer tokens';
  document.getElementById('costSavings').textContent = costSavings + '% cheaper';
  document.getElementById('speedImprovement').textContent = speedImprovement + 'x faster';
}

// Update budget display
async function updateBudget() {
  try {
    const response = await fetch(`${API_URL}/budget`);
    const data = await response.json();
    document.getElementById('budgetSpent').textContent = '$' + data.spent.toFixed(4);
  } catch (error) {
    console.error('Failed to update budget:', error);
  }
}

// Reset system
async function resetSystem() {
  if (!confirm('This will delete all documents and reset the budget. Continue?')) {
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/reset`, {
      method: 'POST'
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Clear UI
      documents = [];
      loadAllResult = null;
      smartResult = null;
      
      renderDocuments();
      updateBudget();
      
      document.getElementById('resultsSection').style.display = 'none';
      document.getElementById('questionInput').value = '';
      
      alert('System reset successfully');
    }
  } catch (error) {
    alert('Reset failed: ' + error.message);
  }
}