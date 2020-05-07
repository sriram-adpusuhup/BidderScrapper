const mongoose = require('mongoose');
const BidderSchema = require('./BidderSchema');

const connectToMongo = () => {
    return mongoose.connect('mongodb://localhost:27017/test', { useNewUrlParser: true })
};

(async function () {
    await connectToMongo();
    const bidders = await BidderSchema.find({ bidder: 'oftmedia' }).limit(1)
    console.log({ bidders })
    // let updatedCount = 0;
    // for (let bidder of bidders) {
    //     const originalCpm = bidder.originalCpm;
    //     if (typeof originalCpm === 'number') {
    //         const stringCpm = originalCpm.toString();
    //         bidder.originalCpm = stringCpm;
    //         console.log({ originalCpm, stringCpm });
    //         await bidder.save();
    //         updatedCount++;
    //     }
    // }
    // console.log({ updatedCount })
    process.exit(0)
})();