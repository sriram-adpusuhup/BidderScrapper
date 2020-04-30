const mongoose = require('mongoose');

const BidderSchema = new mongoose.Schema({
    id: {
        type: String,
    },
    bidder: String,
    size: String,
    originalCpm: String,
    cpm: String,
    responseTimestamp: Number,
    vast: String,
    adUnitCode: String,
    pageUrl: String,
    siteId: Number,
    docType: String
}, { collection: 'vast' });

const BidderModel = mongoose.model('vast', BidderSchema, 'vast');

module.exports = BidderModel;