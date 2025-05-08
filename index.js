const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { google } = require('googleapis');
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = 3000;

const SITE_TOKEN = "3e5695b2ac30548767d8dfe1a9635b496a58657dac28e30a7bd1680f7f3736b2";
const SITE_ID = "63d842ee28d89a29c36eb8d7";

const SHEET_ID = "1Mtd5ZV-jcpvzidZrXvVSFnyfTq0Su9ClwyDz9SnDr5E";
const SHEET_RANGE = 'Sheet1!B:C'
const SHEET_RANGE_UPDATE = 'Sheet1!A:H'

const OUTPUT_FILE = path.join(__dirname, 'orders.json');
const TRACK_FILE = path.join(__dirname, 'progress.json');

// console.log(process.env.GOOGLE_ACCOUNT)

const auth = new google.auth.GoogleAuth({
    credentials:{
        "client_email": process.env.GOOGLE_ACCOUNT,
        "private_key": process.env.GOOGLE_SHEET_PRIVATE.replace("/\\n/g, '\n'"),
      },
    
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttleRequest(fn, args = [], retries = 3) {
  try {
    return await fn.call(null, args);
  } catch (error) {
    if (error.response && error.response.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10);
      console.warn(`🚦 Rate limit hit. Waiting ${retryAfter} seconds before retrying...`);
      await delay(retryAfter * 1000);
      return await throttleRequest(fn, args, retries);
    } else {
      throw error;
    }
  }
}

async function loadProgress() {
  try {
    const data = fs.readFileSync(TRACK_FILE);
    return JSON.parse(data).lastProcessed || 0;
  } catch {
    return 0;
  }
}

function saveProgress(index) {
  fs.writeFileSync(TRACK_FILE, JSON.stringify({ lastProcessed: index }));
}

async function fetchOrdersChunk(offset, limit = 10) {
  return await throttleRequest(async () => {
    const response = await axios.get(`https://api.webflow.com/v2/sites/${SITE_ID}/orders`, {
      headers: {
        Authorization: `Bearer ${SITE_TOKEN}`,
        'accept-version': '2.0.0'
      },
      params: {
        limit,
        offset,
        status: "fulfilled"
      }
    });
    return (response.data.orders || []).filter(order => order.status === 'fulfilled');
  });
}

async function getCMSItem(collectionId, itemId) {
  return await throttleRequest(async () => {
    const response = await axios.get(
      `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
      {
        headers: {
          Authorization: `Bearer ${SITE_TOKEN}`,
          'accept-version': '2.0.0'
        }
      }
    );
    return { itemId, collectionId, item: response.data, fetched: true };
  });
}

async function getProductInventory(variantId) {
  return await throttleRequest(async () => {
    const response = await axios.get(
      `https://api.webflow.com/v2/collections/63ef74b5f1e5b8f06354abf9/items/${variantId}/inventory`,
      {
        headers: {
          Authorization: `Bearer ${SITE_TOKEN}`,
          'accept-version': '2.0.0'
        }
      }
    );
    return { variantId, inventory: response.data, fetched: true };
  });
}

async function getMissingProductDetails(notFoundItems) {
  const productDetails = [];
  for (const item of notFoundItems) {
    try {
      const response = await throttleRequest(() => axios.get(
        `https://api.webflow.com/v2/sites/${SITE_ID}/products/${item.productId}`,
        {
          headers: {
            Authorization: `Bearer ${SITE_TOKEN}`,
            'accept-version': '2.0.0'
          }
        }
      ));

      const product = response.data;
      const getVenue = await getCMSItem('63ef74b5f1e5b8057d54abfd', product.product.fieldData["venue-3"]);
      const getLocation = await getCMSItem('63ef74b5f1e5b8ebbd54abfc', product.product.fieldData["location-3"]);
      const productInventory = await getProductInventory(item.variantId);

      const isoDate = product.product.fieldData['doors-open'];
      const dateObj = new Date(isoDate);
      const formatted = `${dateObj.getDate().toString().padStart(2, '0')}-${(dateObj.getMonth() + 1).toString().padStart(2, '0')}-${dateObj.getFullYear()}`;

      productDetails.push({
        productId: item.productId,
        productName: item.productName,
        productSlug: product.product.fieldData['slug'],
        venue: getVenue.item.fieldData["name"],
        location: getLocation.item.fieldData["name"],
        variantId: item.variantId,
        showDate: formatted,
        productInventory: productInventory.inventory.quantity,
        ticketsBought: item.ticketsBought,
        fetched: true
      });
    } catch (error) {
      console.warn(`⚠️ Skipping productId: ${item.productId} (error: ${error.message})`);
      productDetails.push({
        productId: item.productId,
        variantId: item.variantId,
        fetched: false,
        error: error.message
      });
    }
  }
  return productDetails;
}
  
async function appendOrUpdateSheet(products) {
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  
    // ✅ FIX: Now accepts and uses proper context
    const throttleSheetsRequest = async (fn, context, args = {}, retries = 3) => {
      try {
        return await fn.call(context, args);
      } catch (error) {
        if (error.response && error.response.status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10);
          console.warn(`📊 Google Sheets rate limit hit. Retrying after ${retryAfter} seconds...`);
          await delay(retryAfter * 1000);
          return await throttleSheetsRequest(fn, context, args, retries);
        } else {
          throw error;
        }
      }
    };
  
    for (const product of products) {
      const rangeCheck = `Sheet1!B:B`;
  
      const existingRowsRes = await throttleSheetsRequest(
        sheets.spreadsheets.values.get,
        sheets.spreadsheets.values,
        {
          spreadsheetId: SHEET_ID,
          range: rangeCheck
        }
      );
  
      const existingRows = existingRowsRes.data.values || [];
      const variantIds = existingRows.map(r => r[0] || '');
      const rowIndex = variantIds.findIndex(id => id.trim() === product.variantId.trim());
  
      if (rowIndex !== -1) {
        const targetRow = rowIndex + 2;
  
        const currentRowRes = await throttleSheetsRequest(
          sheets.spreadsheets.values.get,
          sheets.spreadsheets.values,
          {
            spreadsheetId: SHEET_ID,
            range: `Sheet1!A${targetRow}:H${targetRow}`
          }
        );
  
        const existingRow = currentRowRes.data.values ? currentRowRes.data.values[0] : [];
        const prev = parseInt(existingRow[6] || 0);
        const updatedTickets = prev + product.ticketsBought;
  
        await throttleSheetsRequest(
          sheets.spreadsheets.values.update,
          sheets.spreadsheets.values,
          {
            spreadsheetId: SHEET_ID,
            range: `Sheet1!A${targetRow}:H${targetRow}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
              values: [[
                product.productId,
                product.variantId,
                product.productName,
                product.location,
                product.venue,
                product.showDate,
                updatedTickets,
                product.productInventory
              ]]
            }
          }
        );
      } else {
        await throttleSheetsRequest(
          sheets.spreadsheets.values.append,
          sheets.spreadsheets.values,
          {
            spreadsheetId: SHEET_ID,
            range: SHEET_RANGE_UPDATE,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
              values: [[
                product.productId,
                product.variantId,
                product.productName,
                product.location,
                product.venue,
                product.showDate,
                product.ticketsBought,
                product.productInventory
              ]]
            }
          }
        );
      }
    }
  
    console.log(`✅ Processed ${products.length} row(s) to Google Sheet`);
  }
  



app.get('/resume', async (req, res) => {
  try {
    const BATCH_SIZE = 1;
    let offset = await loadProgress();
    let totalProcessed = 0;

    while (true) {
      console.log(`⏳ Loading orders from offset ${offset}`);
      const orders = await fetchOrdersChunk(offset, BATCH_SIZE);
      if (orders.length === 0) break;

      const records = [];
      for (const order of orders) {
        for (const item of order.purchasedItems) {
          records.push({
            orderId: order.orderId,
            variantId: item.variantId,
            productId: item.productId,
            productName: item.variantName,
            ticketsBought: item.count
          });
        }
      }

      const productInfo = await getMissingProductDetails(records);
      await appendOrUpdateSheet(productInfo);

      totalProcessed += records.length;
      offset += BATCH_SIZE;
      saveProgress(offset);

      console.log(`✅ Processed batch, waiting 60 seconds...`);
      await delay(60000);
    }

    res.send(`🎉 Sync complete. Total items processed: ${totalProcessed}`);
  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).send('Failed to resume sync.');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
