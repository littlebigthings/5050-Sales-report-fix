const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { google } = require('googleapis');

const app = express();
const PORT = 3000;

const SITE_TOKEN = "3e5695b2ac30548767d8dfe1a9635b496a58657dac28e30a7bd1680f7f3736b2";
const SITE_ID = "63d842ee28d89a29c36eb8d7";
const GOOGLE_SHEET_API_KEY = "AIzaSyBwla_zTqayVmOElBIGK0PPpuaxORsxORY";
const SHEET_ID = "1Mtd5ZV-jcpvzidZrXvVSFnyfTq0Su9ClwyDz9SnDr5E";
const SHEET_RANGE = 'Sheet1!B:C'
const SHEET_RANGE_UPDATE = 'Sheet1!A:H'

const OUTPUT_FILE = path.join(__dirname, 'orders.json');
const ORDERS_FILE = path.join(__dirname, 'orders.json');


// ✅ Google Sheets Auth Setup
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'google-service-account.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// ✅ Check if a variantId exists and return its row index
async function findRowByVariantId(variantId) {
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE_UPDATE
  });

  const rows = response.data.values || [];
  const header = rows[0];
  const variantIdIndex = header.findIndex(h => h.trim().toLowerCase() === 'variant id');

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][variantIdIndex] === variantId) {
      return i + 1; // 1-based index for Sheets
    }
  }

  return null;
}

// Function to load data from webflow
async function fetchFulfilledOrders(limit = 10) {
  const PAGE_LIMIT = limit;
  let offset = 0;
  let page = 1;
  let total = Infinity;
  let fulfilledOrders = [];

  try {
    while (offset < total) {
      console.log(`🔄 Fetching page ${page} (offset ${offset})...`);

      const response = await axios.get(`https://api.webflow.com/v2/sites/${SITE_ID}/orders`, {
        headers: {
          Authorization: `Bearer ${SITE_TOKEN}`,
          'accept-version': '2.0.0'
        },
        params: {
          limit: PAGE_LIMIT,
          offset: offset,
          status: "fulfilled"
        }
      });

      const data = response.data;
      total = data.pagination?.total || 0;
      const fetchedOrders = data.orders || [];


      console.log(`📄 Page ${page} fetched: ${fetchedOrders.length} orders`);
      console.log(`🧮 Total orders: ${total} | Current offset: ${offset + PAGE_LIMIT}`);

      for (const order of fetchedOrders) {
        if (order.status === 'fulfilled') {
          fulfilledOrders.push(order);
          if (fulfilledOrders.length >= limit) break;
        }
      }

      offset += PAGE_LIMIT;
      page++;
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(fulfilledOrders, null, 2));
    console.log(`✅ Done! ${fulfilledOrders.length} fulfilled orders saved to orders.json`);
  } catch (error) {
    console.error('❌ Error fetching orders:', error.response?.data || error.message);
  }
}

// Check data on G-sheet
app.get('/update', async (req, res) => {
  try {
    // Load orders from JSON file
    const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));

    // Fetch sheet data (columns: variantId in A, productId in B)
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_RANGE}?key=${GOOGLE_SHEET_API_KEY}`;
    const sheetResponse = await axios.get(sheetUrl);
    const sheetRows = sheetResponse.data.values || [];

    // Create a Set of combined "variantId|productId" for quick lookup
    const sheetKeys = new Set(
      sheetRows.map(([VariantID, Show]) => `${VariantID.trim()}|${Show.trim()}`)
    );

    let matches = [];
    let notFound = [];

    // Loop through each order and purchased items
    for (const order of orders) {
      for (const item of order.purchasedItems) {
        const key = `${item.variantId}|${item.productId}`;
        const record = {
          orderId: order.orderId,
          variantId: item.variantId,
          productId: item.productId,
          productName: item.variantName,
          ticketsBought: item.count
        };

        if (sheetKeys.has(key)) {
          matches.push(record);
        } else {
          notFound.push(record);
        }
      }
    }

    // Get missing product info from Webflow
    const productInfo = await getMissingProductDetails(notFound);

    // Write not-found items to Google Sheet
    await appendOrUpdateSheet(productInfo);

    // Return response
    res.json({
      totalOrders: orders.length,
      totalItemsChecked: matches.length + notFound.length,
      matchesFound: matches.length,
      notFoundCount: notFound.length,
      matches,
      notFound,
      missingProductDetails: productInfo
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).send('❌ Error checking orders against Google Sheet');
  }
});

// Get product info from Webflow for unmatched items
async function getMissingProductDetails(notFoundItems) {
  const productDetails = [];

  for (const item of notFoundItems) {
    try {
      const response = await axios.get(
        `https://api.webflow.com/v2/sites/${SITE_ID}/products/${item.productId}`,
        {
          headers: {
            Authorization: `Bearer ${SITE_TOKEN}`,
            'accept-version': '2.0.0'
          }
        }
      );

      const product = response.data;

      const getVenue = await getCMSItem('63ef74b5f1e5b8057d54abfd', product.product.fieldData["venue-3"]);
      const getLocation = await getCMSItem('63ef74b5f1e5b8ebbd54abfc', product.product.fieldData["location-3"]);
      const productInventory = await getProductInventory(item.variantId);

      const isoDate = product.product.fieldData['doors-open']
      const dateObj = new Date(isoDate);

      const formatted = `${dateObj.getDate().toString().padStart(2, '0')}-${(dateObj.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${dateObj.getFullYear()}`;

      // console.log(getVenue.item.fieldData.name);
      // console.log(product.product.fieldData)

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
      console.warn(`⚠️ Skipping productId: ${item.productId} (not found or error) ${error}`);
      productDetails.push({
        productId: item.productId,
        variantId: item.variantId,
        fetched: false,
        error: error.response?.data?.message || error.message
      });
    }
  }

  return productDetails;
}

// Get the inventory data
async function getProductInventory(variantId) {
  try {
    const response = await axios.get(
      `https://api.webflow.com/v2/collections/63ef74b5f1e5b8f06354abf9/items/${variantId}/inventory`,
      {
        headers: {
          Authorization: `Bearer ${SITE_TOKEN}`,
          'accept-version': '2.0.0'
        }
      }
    );

    return {
      variantId,
      inventory: response.data,
      fetched: true
    };

  } catch (error) {
    console.warn(`⚠️ Failed to fetch inventory for productId: ${productId} — ${error.response?.data?.message || error.message}`);
    return {
      productId,
      fetched: false,
      error: error.response?.data?.message || error.message
    };
  }
}

//   const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

//   // Load existing variantIds
//   const existingRows = await loadSheetRows(SHEET_RANGE_UPDATE);
//   const header = existingRows[0];
//   const dataRows = existingRows.slice(1);

//   const variantIdIndex = header.indexOf("Variant ID");
//   // console.log(variantIdIndex)
//   const ticketsBoughtIndex = header.indexOf("ticketsBought");

//   for (const product of products) {
//     let matched = false;
//     for (let i = 0; i < dataRows.length; i++) {
//       const row = dataRows[i];
     
//       console.log(row[variantIdIndex])
//       console.log(product.variantId)

//       if (row[variantIdIndex] === product.variantId) {
//        console.log("update")
//         // ✅ Match found: Update ticketsBought
//         const prev = parseInt(row[ticketsBoughtIndex] || 0);
//         row[ticketsBoughtIndex] = prev + product.ticketsBought;

//         await sheets.spreadsheets.values.update({
//           spreadsheetId: SHEET_ID,
//           range: `Sheet1!A${i + 2}:H${i + 2}`,
//           valueInputOption: 'USER_ENTERED',
//           requestBody: {
//             values: [[
//               product.productId,
//               product.variantId,
//               product.productName,
//               product.location,
//               product.venue,
//               product.showDate,
//               row[ticketsBoughtIndex],
//               product.productInventory
//             ]]
//           }
//         });
//         matched = true;
//         break;
//       }
//     }

//     if (!matched) {
//       // ✅ New row to be appended
//       await sheets.spreadsheets.values.append({
//         spreadsheetId: SHEET_ID,
//         range: SHEET_RANGE_UPDATE,
//         valueInputOption: 'USER_ENTERED',
//         requestBody: {
//           values: [[
//             product.productId,
//             product.variantId,
//             product.productName,
//             product.location,
//             product.venue,
//             product.showDate,
//             product.ticketsBought,
//             product.productInventory
//           ]]
//         }
//       });
//     }
//   }

//   console.log(`✅ Processed ${products.length} row(s) to Google Sheet`);
// }

// ✅ Append or update rows in Google Sheet using index search
// ✅ Append or update rows in Google Sheet with real-time row lookup
async function appendOrUpdateSheet(products) {
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  for (const product of products) {
    const rowIndex = await findRowByVariantId(product.variantId);

    if (rowIndex) {
      // ✅ Match found: update row G
      const currentRow = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `Sheet1!A${rowIndex}:H${rowIndex}`
      });

      const existingRow = currentRow.data.values[0];
      const prev = parseInt(existingRow[6] || 0);
      const updatedTickets = prev + product.ticketsBought;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Sheet1!A${rowIndex}:H${rowIndex}`,
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
      });
    } else {
      // ✅ Append as new
      await sheets.spreadsheets.values.append({
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
      });
    }
  }

  console.log(`✅ Processed ${products.length} row(s) to Google Sheet`);
}





// Get the venue and location data
async function getCMSItem(collectionId, itemId) {
  try {
    const response = await axios.get(
      `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
      {
        headers: {
          Authorization: `Bearer ${SITE_TOKEN}`,
          'accept-version': '2.0.0'
        }
      }
    );

    return {
      itemId: itemId,
      collectionId: collectionId,
      item: response.data,
      fetched: true
    };

  } catch (error) {
    console.warn(`⚠️ CMS item fetch failed for itemId: ${itemId} (ignored)`);
    return {
      itemId: itemId,
      collectionId: collectionId,
      fetched: false,
      error: error.response?.data?.message || error.message
    };
  }
}



// GET /sync endpoint
app.get('/sync', async (req, res) => {
  try {
    const count = await fetchFulfilledOrders(99); // Test run with 10
    res.send(`✅ Synced ${count} fulfilled orders and saved to orders.json`);
  } catch (err) {
    res.status(500).send('❌ Failed to sync orders');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
