const parseString = require('xml2js').parseStringPromise;
const axios = require('axios');
const ObjectToCsv = require('objects-to-csv');

const States = {
    SUCCESS: 1,
    FAILURE: 0,
    CONTINUE: 3
};

const allSettled = require('promise.allsettled');

const processXml = async (xml) => {
    const res = await parseString(xml);
    if (res && res.VAST && res.VAST.Ad && res.VAST.Ad[0]) {
        let adData;
        if (res.VAST.Ad[0].InLine) {
            adData = res.VAST.Ad[0].InLine[0];
        } else {
            adData = res.VAST.Ad[0].Wrapper[0];
        }

        const result = processAdData(adData);
        return result;
    }
    return {
        state: States.FAILURE
    };
}

const processLowestBirateMediaFile = (mediaFiles = []) => {
    let curHeight = mediaFiles[0].$.height;
    let curWidth = mediaFiles[0].$.width;
    let currentLeastBitrate = parseInt(mediaFiles[0].$.bitrate);
    // console.log('======================================= \n')
    mediaFiles.forEach(file => {
        const data = file.$;
        const height = data.height;
        const width = data.width;
        const bitrate = parseInt(data.bitrate);
        // console.log({ bitrate })
        if (!!bitrate && bitrate < currentLeastBitrate) {
            curHeight = height;
            curWidth = width;
            currentLeastBitrate = bitrate;
        }
    });
    // console.log({ currentLeastBitrate })
    // console.log('=========================================== \n');
    return {
        height: curHeight || 'null',
        width: curWidth || 'null',
        bitrate: currentLeastBitrate
    }
}

const processAdData = adData => {
    const Linear = (
        adData.Creatives && adData.Creatives[0] && adData.Creatives[0].Creative &&
        adData.Creatives[0].Creative[0] &&
        adData.Creatives[0].Creative[0].Linear
    ) ? adData.Creatives[0].Creative[0].Linear[0] : null;
    if (Linear) {
        const MediaFiles = Linear.MediaFiles && Linear.MediaFiles[0];
        if (MediaFiles) {
            // console.log({
            //     mediaFiles: MediaFiles.MediaFile && MediaFiles.MediaFile.length
            // });
            return {
                state: States.SUCCESS,
                data: processLowestBirateMediaFile(MediaFiles.MediaFile)
            };
        } else {
            // console.log('no media files');
            const nestedUrl = adData.VASTAdTagURI[0];
            // console.log({ nestedUrl });

            return {
                state: States.CONTINUE,
                data: nestedUrl
            };
        }
    }
    return {
        state: States.FAILURE
    }
}

const splitPromisesToChunks = (promises = []) => {
    const CHUNK_SIZE = 500;
    const chunks = [];
    const promisesSet = [...promises];
    while (promisesSet.length) {
        const subSet = promisesSet.splice(0, CHUNK_SIZE);
        chunks.push(subSet);
    }
    return chunks;
}

const processAWrapper = async wrapper => {
    const xmlLink = wrapper.xmlData.VAST.Ad[0].Wrapper[0].VASTAdTagURI[0];
    try {
        const xmlData = await axios.get(xmlLink);
        const result = await processXml(xmlData.data);

        return {
            data: result,
            bidder: wrapper.bidder
        };
    } catch (e) {
        // console.log(`Error calling xml scrape link ${wrapper.bidder.id}`);
        // console.log({ e });
        return null;
    }
}

const secondLevelParse = async data => {
    const link = data.data.data;
    try {
        const xmlData = await axios.get(link);
        const processedData = await processXml(xmlData.data);
        return {
            data: processedData,
            bidder: data.bidder
        };
    } catch (e) {
        console.error('error at second level parsing');
        console.log({ message: e.message });
        return null;
    }
}

const processSecondLevelParsing = async parseData => {
    const promises = parseData.map(secondLevelParse);
    const promisesChunks = splitPromisesToChunks(promises);

    const results = [];
    let noChunks = 0;
    for (let promiseChunk of promisesChunks) {
        ++noChunks;
        console.log(`processing chunk ${noChunks}`);
        try {
            const responses = await allSettled(promiseChunk);
            const successResponses = responses.filter(res => res.status === 'fulfilled' && res.value !== null).map(res => res.value);
            results.push(...successResponses);
        } catch (e) {
            console.log(e.message);
        }
    }
    return results;
}

const parseWrappers = async (wrappers) => {

    const promises = wrappers.map(processAWrapper);
    const promisesChunks = splitPromisesToChunks(promises);

    const results = [];

    let noOfChunks = 0;
    let failedCount = 0;
    for (let promiseChunk of promisesChunks) {
        ++noOfChunks;
        console.log(`processing chunk ${noOfChunks}`);
        try {
            const responses = await allSettled(promiseChunk);
            const successResponses = responses
                .filter(res => res.status === 'fulfilled' && res.value !== null)
                .map(res => res.value);
            failedCount += responses.filter(res => res.status === 'fulfilled' && res.value === null).length;
            results.push(...successResponses);
        } catch (e) {
            console.log({ e });
        }
    }

    console.log({ failedCount });

    return results;
}

const parseInlines = inlines => {
    // return processAdData(inlines[0].VAST.Ad[0].InLine[0]);
    const xmlResults = inlines.map(inline => processAdData(inline.xmlData.VAST.Ad[0].InLine[0]));
    return xmlResults.map((res, i) => ({
        data: res,
        bidder: inlines[i].bidder
    }));
}

const processBidders = async (bidders = []) => {
    const state = {
        totalBidders: bidders.length,
        biddersWithoutVast: 0,
        noWrapper: 0,
        noInline: 0,
        noWrapperOrInline: 0
    };
    // filtering our bidders from db without xml
    const filteredBidders = bidders.filter(bidder => !!bidder.vast);
    state.biddersWithoutVast += state.totalBidders - filteredBidders.length;
    if (filteredBidders.length === 0) {
        console.log('No bidders have xml data');
        return null;
    }

    // parsing filtered xml into objects
    const parseQueries = filteredBidders.map(bidder => {
        return parseString(bidder.vast);
    });
    const responses = await Promise.all(parseQueries);

    // mapping each parsed response with it's respective bidder data from db
    const responsesWithId = responses.map((res, i) => {
        const bidder = filteredBidders[i];
        bidder.vast = null;
        const xmlData = res;
        return {
            bidder,
            xmlData
        };
    });

    // filtering data with valid structure to parse
    const bidsData = responsesWithId.filter(res => res.xmlData && res.xmlData.VAST && res.xmlData.VAST.Ad && res.xmlData.VAST.Ad[0]);

    // some bids have <Wrapper> 
    const wrapperData = bidsData.filter(res => res.xmlData.VAST.Ad[0].Wrapper && res.xmlData.VAST.Ad[0].Wrapper[0]);
    // and some have <Inline>
    const inlineData = bidsData.filter(res => res.xmlData.VAST.Ad[0].InLine && res.xmlData.VAST.Ad[0].InLine[0]);

    state.noWrapper = wrapperData.length;
    state.noInline = inlineData.length;

    state.noWrapperOrInline = state.totalBidders - (state.noWrapper + state.noInline);

    // -------- parsing wrappers first -----
    // <Wrapper> links to a separate xml. Need to query the page and parse it to get dimensions
    const wrapperResults = await parseWrappers(wrapperData);

    // ------ parsing inlines ------
    // <InLine> has the dimensions embedded in themselves.
    console.log('---------- PARSING INLINES ------------')
    const inlineResults = parseInlines(inlineData);

    console.log({
        wrapperResults: wrapperResults.length,
        inlineResults: inlineResults.length
    });

    const totalResults = [...wrapperResults, ...inlineResults];

    const allSuccess = totalResults.filter(res => res.data.state === States.SUCCESS);
    // some have two levels of nested link to get and parse. This is the second level. first level is done at this point
    const allToContinue = totalResults.filter(res => res.data.state === States.CONTINUE);
    const allFailed = totalResults.filter(res => res.data.state === States.FAILURE);

    console.log('---- PROCESSING SECOND LEVEL ------');
    const continueResult = await processSecondLevelParsing(allToContinue);

    console.log({
        success: allSuccess.length,
        failure: allFailed.length,
        continue: continueResult.length
    });
    return {
        results: [...allSuccess, ...continueResult],
        state
    };
};

// VAST -> Ad -> Inline -> Creatives
const districtm = {
    VastBucket: {
        adUnitCode: "ADP_37780_160X600_8b476cee-75c9-4caf-a662-cd49b79c2ba9",
        bidder: "districtm",
        cpm: 0.487413,
        docType: "vastdump",
        id: "1058a7fb6a407be6",
        originalCpm: 0.54157,
        pageUrl: "https://www.javatpoint.com/html-text-editors",
        responseTimestamp: 1587750000295,
        siteId: 37780,
        size: "120x600",
        vast: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><VAST version=\"3.0\"><Ad id=\"216107394\"><Wrapper><AdSystem version=\"2.0\">DBM</AdSystem><VASTAdTagURI><![CDATA[https://bid.g.doubleclick.net/dbm/vast?dbm_c=AKAmf-DZSZld57rHGpLwI2bBkMP2SLabWyk3hB6XV8mcJZQLcMTpzHuXR7nkHKlLLXu-eke2Z6E6&dbm_d=AKAmf-ChvUEqCxwwzt0UBjIsA--ZaTNVVFDOvQ4UqHPdciCzQUTvdvtfHADeGrL4g-xi62-pN1Jl_H97aaE2-nU5srw7oF7DQrceUy0f-EmC8YN-Lne5Sicp02iUSQFPqXn_7qFwafxOnMe2oKlS3A8GNlKGxKYhS3hQ0epmEufE2W8Gj6zR-HKzZ69ZSMl0PnakYKvIUb3TFnlSmJanFCkLI5HRBG5VjOfpfnSJAnTSfjpBjt5zWBN-0dOkNDJt8CHqIwUzdqJryLtKuJVOj2beSbLOGlKJ_oxQACLJ5grpgmhqb7JeixzcotzlrAZ-XqQivb-Svba3gR6KSkIqNOaDB3wxI29me6DkL4Gl66S6IEanELZqzseu9Pk1K9MF_C_7w4m_JcTHxIIHh7hZJcThcGAb_uYmft9fZgzU6spyDjrY2EiSlZpg2R9cUob-Fgk6IxzpLeAbcHguhpMe-pMh8bsS3bVXnVWrKPOxondjmYRTrmNgpAbzZJGDn5X5qfv2KpeFvuTYU71hutTBGyyvA-nEihmQ_NOTS1Qn4K_8nmLGLSfdppVQ6Q7Bjwz7UwODuICYmn0YH_8na_9lIAqQj74ViHzvMlZxOptop2VLSWViBte5tfR_5wkMcfaWjNdgh8lGIdNeI4_zyTTvdXFwGWrENTpRulOgtL4xgu7gyW6fFNkrWubPVQh1_JylVV0MwufdBMna3A3PvncbBSUqG1ebb_tF6wlh3HJcOLZKdi96KFH90dk4M9nP-JQN-DnrmRNpF3ya6H9prUeCUm40FWA5cWCqcl4f6KoB49gCJKFSLnqS8gCiEWDrUqx4qFwYS8Y3Ujmw5BJyLVB1CSNzixL7ycArFl6cGazDWpevzHiohg6o1eMi9r6y-GxdwzV6oElQTgIWpSI2CH6sm4_oFrWhCdyr48VsW-13MCG-sVkXUzmdbbPe5xXcMGiJuDMJkNPBkB0JpVnvPEfvxM_Ux4Vwx7UNV10uoFQrRPfSr2Iv0ZtCR6s2TXE0SSH-gRr7xqygIutI2hPgAdh2bMyxw9OKGGIUEv-g0tbQRkCV3P5ukMvBS0Xfrj3BNOGXItBxG1Bq3fP9pldXPN2AghbsMxeK0FHCHAugG72ryUG8qItSVmp7BaYeOlM8aGd5EQwQXIVwbVEVVmvXg97c5LnwCk-8uGYyYe5Ln_W5q8gf7Po0hgHOOPJ2eXejXBXvJrzuC5K81yBr8IXlIUj1pUAlH-bu-PVjAn6qLy3F-mtDBy8jtGCNFlJX7VoK1yBLHFrNjcFdn1uxIueXrv7jE_MZawRiccjwZRitsVVLqX2PspzJ1-ERyED9-hFI4_RJPaZftQMj4hczyKBCzy6zcaMaJBDNA_c9e3e06-uzpr7wwKFM_7KfJDnmNezb-mTPuUrQ_fx6rCGLbdK6spWPwFbTwMeOxkNoxAizrVUKU3HzThYfIvFcy9CIRLW_Rn8xvQiQIY87eASS7RxYcPIKf1er9oromhxy-SLCON9gMY1KwnjfO9tENPc0oVq5Jeg64_pjUrR0uyTWDO7LxgI8xKEBAhIdoMvdLP2x5_pUp1SFVEw3nocEasU9LZQU78yvKFq-VRhaNlUTirbyLir_LrvL-tPeBFtJZ4ouFbCxlQw30GcJpu0yiAQxmDudMTl4WProoU0KVBJs02VKLQB_Sv6uF2kDhaeOXWWJ8oXGOZCEcfuqQizxZbNEZWQVLkTixts9XQXMVX75UcSEGri7Kj9_SNXe2JQR4WIKJC0Ab7fou5U_RYlmaJsso9UnkbS6gws5XWKt0k0Ywg496ez8d2rsonqRgZ4frfdluGnJv82nh-98q4VVJ04XUiIpquR4l5hld7i81La3YAgYfZfXxf8E6bWzTlXjlTKJAAihXbjJ81jakA3btpxYQgbpoRZO7fX28Rdf3LoPgyqipLFJYILmJAzFgOLtlzNOB-iSa6E2CMh9ZmjIbVgoSHpoaTxWcgKuRaPebXqIYbWzsk6IX5dviF1Wz9iBTMawV0yZv7IA-0QTCI_xLrIIRt3ElA0vdO9nX0QmlUw5j8CLmhD4XXB5KEJh3N9dnzz2BbiQabNmFMlPJHqwrvUgaB9TXKd7vmvqm55V50k1j7n9Tn0OVZZlYBgRF-c-gxiOWH1yQwVFNVbFe6a8XUWvhLwt7ptvza0Yf-Xay3GPlBiuNjeKz-AdO1ZcjapeVZ7gs59oLESewn0z0QZBoz8ecaaNsz-6l5IvedkaoF9nAeV1zMtZzZEMzRaOc6C4uCsNTYNbfUJUHeZ5MeVtOY7SVo6QzUAk7OI3z4fEf0YUUPzeFqbHdgDyeSM_SoPxnm_cXTz_u3rVWnJAqqcaWeScqCRkueEdAU1Cvtbw_f9yXtTUsqz5zAgHNSrWs-kN89pvZbHwr5vAzUwfJeioxcVE213RLsF3pGdoQFgp1JNkGmbseIEvmuYEDBcNlX-4DNgfn4XhYs-YbkQ8iWGA3GnWGYlFqM4Q_JFTW30bSvh15Qro_LGsyk6daugJ43cYrvs3s930hNJch-rxpE5ratlobbtR7xIyvujSqsEk4F-7KFL1kifnKAOo8A7ecJDDV6dN95FiPTOUVvEDJBV8XUxdMOvv8ZgG-LIcoURPAb6Z7tzzFpeOpyI-7_UqAEnXUDfpys4xShpyRYXfA3KrxLDLcsE_Jt-K0hSqzbnBt_3XR2yRVwkJ5mcUTSI8lAbSbMgmxUxsCtvp-czaKZdSqKTUcnExeZmDOWANpO5ns0HWB_2wu-zZDO6kwUua650m1oQxj6-s11-J6Na9GlrECgrKDPry-lXjhgHwKMw6dAgbTAXd1_ncIYNeGFXfcjaqrksmXSiXw1wfDcvAPT-9F3dB_jBtrvCiUXWO8a4l_iyS&pr=10:0.626093&cid=CAASEuRoSjVKlW5EWolt00cBpAzOsg]]></VASTAdTagURI><Error><![CDATA[https://sin3-ib.adnxs.com/vast_track/v2?info=ZwAAAAMArgAFAQlyJKNeAAAAABEcfjbDUMS-ZBlyJKNeAAAAACCCk4ZnKAAwvAk49A5ArLZXSOP7-AFQ0dn8BljyjAFiAklOaAFwAXgAgAECiAEEkAF4mAHYBKABAKgBgpOGZ7ABAQ..&s=993970953ef8372e4e509a487d9bbf7facf8005d&event_type=4&error_code=[ERRORCODE]]]></Error><Impression id=\"adnxs\"><![CDATA[https://sin3-ib.adnxs.com/it?an_audit=0&referrer=https%3A%2F%2Fwww.javatpoint.com%2Fhtml-text-editors&e=wqT_3QLPHPBMTw4AAAMA1gAFAQjyyIz1BRCc_NmZjIqx32QYlsrQm5eAluhOKjYJGCXoL_QI5D8RVCq4iotU4T8ZAAAAIFyPCEAhVCq4iotU4T8pGCUJJNAxAAAAANej0D8w0dn8Bjj0DkC8CUhlUIKThmdYl_RrYABolPySAXjNuAWAAQGKAQNVU0SSAQEG9MINmAEBoAEBqAEBsAEAuAEDwAEFyAEC0AEA2AEA4AEA8AEA-gEMZG0tcGwtMjc5MjA52AL1P-AC5J9O6gIsaHR0cHM6Ly93d3cuamF2YXRwb2ludC5jb20vaHRtbC10ZXh0LWVkaXRvcnOAAwCIAwGQAwCYAxegAwGqA74YCocYaHR0cHM6Ly9iaWQuZy5kb3VibGVjbGljay5uZXQvZGJtL3Zhc3Q_ZGJtX2M9QUtBbWYtRGIzUlNmLW1KeGFTQ0VnUFBMcUw4aFUxRjBOQlF4aVYycGY5NDlWMUdCbGE3TG94UElCTnBySGNaZEFzUWZLR2ZBdkI0eE5RbVhSVWJMOC1ITlRRUHBUVFBoV1EmZGJtX2Q9QUtBbWYtQWU5TmVXUUZrSXdDWlJVaXBHU2szUnhaeWVhTUs5X18yXzhhaUdyci1tb2d3MEl1Qk5xd1Jyb3dNeFNka2tVZWpHMkpXMzJPeUQta3ZwT3BhUkNpLWx1U0hfSmpjcGh2cTM4REhoTUNtSXpNc2NsLUxPZVpyVExsRjM2ZDV2ZGkyT0lOT1JWRy1TQnpfZFhBcVpoZmpYOFVibkNSVE90NTZEdWRiQ1B5NExSNGNaM3Uwal9EbDdrcVhsaUpYazhPbWMyRHZfanhQbDVQYXRubnpmT3gwN0FYSExyLUVpdHN5N0hYSDVhanpfV3lsVnJRMXd1dURydmVvVUtRUDNESm5CdGNjdHRsanNaNmFZME9yOGU3UXFNMTlWVzc0RWVsdWFvTmNiVFVMTDc2ZHRpay1sQm4zc0Z5VXVESlc0Tmw1V2l5RllINVhsUFNzVnYteTg2OElxQ3BXX0VfdFpKTU5zbWk1S1dMblJJY3NiRnQwVDhtYnM3ckZpMTJYMDlRUlVzaVBLUVA1NzdHMV9OMnBmZXotSE44ZlljSy1nNHhrZEJVUVctanBUUGNlczdybEMwRVF2azV4d0dhQlViVlQwZngwWXRFWExNTmJIeUxOWE41VXRQMWxnYW1VellzVWlYZkMtUTZRYUxfeDhzYTdiNVJXS0J5MGtrcWplSnZIODNPbmotZ2o4TWVrZXRLb2YyR1cxUVNqd3Fmekk3cURUQmJ2UXdGdXBOQTQtbWVMUldOcDZiQzgzOXVYclZFN040eUsyVE9PZ0p2MnluXzZKU0ZSNzVMTkdqSTVsV3l1Vkk3QjQzTkJjVGhBZzBZV05iQV8xMHdRSXYwNzF6cnE3YXFqUFprcVZ1dVVkTTRmajBndUFGc29od0VfaHJSbnI4aGNJU0pGVDJWTGZsWWN1VS1NTW4tUmE2dHh4aUYtcnlheUVKNzI5NmE1eVJvWjhFekRVUG52QjhaQTZ2TE42QzIyT192UkRvbExfaUJoWXdqcUxMNGllNjNZZUZFZGdyOXR1ejgzLXdYQ3UweTI3dlE3b1pfZmRuaHV5d0JlOUl5bkRQX2hDRkU0WkF6a3AxNG13VFhnYUpqNmhqNHNfMWNnYmlwWlllSXZwTGJQQmFHdTlnU0V4THpDenZMU3hVTnhSRzMxT1c1Q19OTC10WHlPd05meUtGdVRrYS1zRllLTm85UmplNkEzXzRpdTVQODlUMnZnQWdGUFVqSDh6bmp3c0RaLVp4dDktdnZYSHdWcnBlVFhUai0yblQwSUxRYXRieXAzN1hLa21QUVJXWkQwX2ZKWU96aVFTQ25KVWdQckt6a3lucHRKUWl4ME1JX2V3NS1CemUyb2ZGR3VEMU4yR2NuWW1kYnBXT3BRVnRqYzF2NEJiYW0zeXVUYXRtU3Nra3JOQTI1TlcycGo5bmxEYUx3eE9ReUNhYkdzWFFUT3JKRk1LWWZ4RGpEVFByTXZaMENmZUhZM2JFQ3Fmcy12dmVOeHZKV0ZoZ1U4cTdrY2I0Zzhoc01KU2kxa095eHlhb3JkMW1xNVpNb0tDM3ZSemdLUGhMVmVnc1dtRjFaR3dsNnk4MnNEWEZzejR6dVNGSVZabEFEbHpjSndRM2hDeGxzOTBTY1hfamkwZDU0cFo3T3p1aGVia3V6eGpVOWo1WEFVSm1QUTFoMDRMa3VvMkVoSlpOYm5IZzFVS1RJUnhBdnh0VERvdVhFcFFBVUtXQk91N3FyZWg0U3BuU3JKU09NU0hBZE1UencwN1c4N3MzeF9hMzJ4ZmhkNXptRHMxQWg0eHlfVm9mQThReGxwRG5LM25Ibi1Ib1lxNS1HaFBhWE9LWlBwNE12SFV0LXFvV1AxSmhLQmRRaF9nV1A0QTdBZXFzSUtPaW9iOXpta0NpTHk0Y2FlUnE0T0h3OTBMbXBKQjZzTkZ1R0RmZHF3YjlESFpaN3plMXlJcWxpQXQzUmN2RFRKVGpvRzkzMk42V2ZnWFQ1aWxzU29Pa3BJQWdQNkRycUFMOE1MdjVQaHJsaTZiR1d0SjZTOGVMSzVuT0JHZGxxWHg3T2xZcHhEb3NxVW85YlZpaDM1djNxbTVCbVZRU3RYdDNZY1l2cHlVbFRGT3ZzQzJCQnp5V1NYWlQ3bzJvVWpwdlNBc1RldGFsUHdOTGY2b1laS1lEVkVkR0RJbGhZT1liYUZKdG4wU1M2S3NQY05FY3Jpd25oOWpvaGk2dEFFSTNoQ1dvQ1N2c2owYTh4MjlYcmZzZG5TVmpJeHhiQ1Y4Nm9wcFpSZWJNdHBmT1VvbUsxdkNQMEl0WHBZc3A5cHFWb1dWREJad05xZzVLV2MyN1dGN21iZ2VBRmV3SERZcUxka3Y3WkVXMHJ3TDE3WnBZZFRpb1FZZTFOSVRKYlJCd3ZYV2NnVndjaVcyaDBRYlRlaGM4Ry1RUHcteHdvdXFNU1BYN2k3X0FNNlZZUlF1QkFkSUtGTml1amtuLVl1WjJzc2NyZzFmWXhKd3p3ZmVPLVJJUlpfNjZFU0VVVEhreE8zZ3NvSG1qaGdaS2I0VWduTGJ0akhGckNjbjFtX2xkMFZZd01tM2VOeDdsWW5YRWlsd0pzNkpyeHhaWFJlUG1aX3NLLUI0TWRfRmw4TDdRaGhsZTBMU1c0R3pRTVRsUVRjVUU4dTM2RnlSbHN3LWZLNTlVY2FIY0p1clpORWlyNlc0N2NwejZEOXZoWmRmS1BCX3lobWM5czZiOG84eGI5bS1WNXJCd2RiTGlPUXFyVEY5Y2pOdDZXR1FXdWxwSmp5TEtRLUtUcmlUM21NT24zR0kxQzNBY3lUb2VmVXdnd3BCUFphNmpPaURDcklXbk1tNGRjejg5Q1RSem0weHNWaFFNMkI2Ty1qWERQY05WZGNuQ3h2aFRqR21iM2l3YVBJd1JjbXZGVW9acnp5cU42b3l6dVUtejlSOUF6QzhzR2VOV2MtWW1RMkpzMkx2bC1pbmh3N3VqTnJHbF8yV3praktBVWIxUmZXSXJ3V3IyMzBzYTNtaE9QNTE2WmRIdlktaU1qRVNFSkRZenBmYnhrVEtWNG5id0FiMlNONnZWV1BqNjFrUFJoa3FuU2pFeEt6ei14elM2VWVjX0N2c21IUWMzR012NWhqMDltVFRlb1pSXzN4N0NNRFR1R2xoOHN6S0FUdXBqX3NQaVo2bW1pS1RHcm5xajVoOU82THoyR0VONm1Ldk5CY0FYSHVyY1dfNXNVeVJhUWxueXFFR2daeVJlaTFzY3ZwSmVtYU1mTS1UTFoxckQ2NWdBaXNUcGNYdkxmQy1YT2NjSXlHME5CYzFvelo0a1p4bHlJSGc4S3VjNGZ3ZmQxZGNIeGxtLXhKZkdJQUw4U3I2MnVaWUx4QW42Q29qTWhwS1JOTExIWTBFRlFvLTJEbW1MbkxLZFZnYU5YZTJ1T0N0UUlTNW1uTW5tME5rQUlHZEs4WUh3bnJDclQyRFB3X3dESERWcTBoYzlHTzhhX3Z0MlRHekthMmxyMk5GdUJCU3ctU2Q5M3RWMGlnblJXQldwbmczc0EzZlBqMGF2SVVrOXczVzAzZ2w3b01NeENsTEllakxnb1hFaThnckp2M3AwMUw2dUxfSy0yZlpJRld2SFVBeEZONnF3Y2RldFUxSHpxdy1CT2FsZEgwMFNxQ1d6YkZ0bXl6dmstX1RwMk1tTms1VXQ5Ylg0bGRQVWFhVTZwUzFIUmh4NXc2NmVJekVhalBzbUpDTmk1Ty1HOTZpMXo4TWZPTncwWVEyRnNmaGN5SVBLSTUwT19YeE8zeUdObGJlUFdRJmNpZD1DQUFTRXVSb1NqVktsVzVFV29sdDAwY0JwQXpPc2cmcHI9MTA6JHtBVUNUSU9OX1BSSUNFfRoTNzI1OTQ1NTUwMDUxOTM3NDM2NCIJMjE2MTA3Mzk0KgcxNzc1MjQyOgkyMjg3MDk4NzXAA-CoAcgDANgDv5s04AMA6AMA-AMBgAQAkgQNL3V0L3YzL3ByZWJpZJgEAKIEDTU5LjE0NC4xOC4xMTioBOr4FrIEEQgEEAQYeCDYBCgBKAIwADgDuAQAwATiy4IiyAQA2gQCCAHgBADwBIKThmeIBQGYBQCgBf3E7o-ZsPvfGsAFAMkFAAAAAAAA8D_SBQkJAAAAAAAAAADYBQHgBQHwBfKMAfoFBAgAEACQBgGYBgC4BgDBBgAAAAAAAPA_0AbLRdoGFgoQAAAAAAAAAAAAAAAAAAAAABAAGADgBgTyBgIIAIAHAYgHAKAHQKoHCDM1NTQ2MjUyyAcA0gcNCQAAAAAAAAAAEAAYAA..&s=78c520c54e6fb56a907ece549564ada0e6588867]]></Impression><Creatives><Creative id=\"11974802\" adID=\"216107394\"><Linear><TrackingEvents><Tracking event=\"start\"><![CDATA[https://sin3-ib.adnxs.com/vast_track/v2?info=ZwAAAAMArgAFAQlyJKNeAAAAABEcfjbDUMS-ZBlyJKNeAAAAACCCk4ZnKAAwvAk49A5ArLZXSOP7-AFQ0dn8BljyjAFiAklOaAFwAXgAgAECiAEEkAF4mAHYBKABAKgBgpOGZ7ABAQ..&s=993970953ef8372e4e509a487d9bbf7facf8005d&event_type=2]]></Tracking><Tracking event=\"skip\"><![CDATA[https://sin3-ib.adnxs.com/vast_track/v2?info=ZwAAAAMArgAFAQlyJKNeAAAAABEcfjbDUMS-ZBlyJKNeAAAAACCCk4ZnKAAwvAk49A5ArLZXSOP7-AFQ0dn8BljyjAFiAklOaAFwAXgAgAECiAEEkAF4mAHYBKABAKgBgpOGZ7ABAQ..&s=993970953ef8372e4e509a487d9bbf7facf8005d&event_type=3]]></Tracking><Tracking event=\"firstQuartile\"><![CDATA[https://sin3-ib.adnxs.com/vast_track/v2?info=ZwAAAAMArgAFAQlyJKNeAAAAABEcfjbDUMS-ZBlyJKNeAAAAACCCk4ZnKAAwvAk49A5ArLZXSOP7-AFQ0dn8BljyjAFiAklOaAFwAXgAgAECiAEEkAF4mAHYBKABAKgBgpOGZ7ABAQ..&s=993970953ef8372e4e509a487d9bbf7facf8005d&event_type=5]]></Tracking><Tracking event=\"midpoint\"><![CDATA[https://sin3-ib.adnxs.com/vast_track/v2?info=ZwAAAAMArgAFAQlyJKNeAAAAABEcfjbDUMS-ZBlyJKNeAAAAACCCk4ZnKAAwvAk49A5ArLZXSOP7-AFQ0dn8BljyjAFiAklOaAFwAXgAgAECiAEEkAF4mAHYBKABAKgBgpOGZ7ABAQ..&s=993970953ef8372e4e509a487d9bbf7facf8005d&event_type=6]]></Tracking><Tracking event=\"thirdQuartile\"><![CDATA[https://sin3-ib.adnxs.com/vast_track/v2?info=ZwAAAAMArgAFAQlyJKNeAAAAABEcfjbDUMS-ZBlyJKNeAAAAACCCk4ZnKAAwvAk49A5ArLZXSOP7-AFQ0dn8BljyjAFiAklOaAFwAXgAgAECiAEEkAF4mAHYBKABAKgBgpOGZ7ABAQ..&s=993970953ef8372e4e509a487d9bbf7facf8005d&event_type=7]]></Tracking><Tracking event=\"complete\"><![CDATA[https://sin3-ib.adnxs.com/vast_track/v2?info=ZwAAAAMArgAFAQlyJKNeAAAAABEcfjbDUMS-ZBlyJKNeAAAAACCCk4ZnKAAwvAk49A5ArLZXSOP7-AFQ0dn8BljyjAFiAklOaAFwAXgAgAECiAEEkAF4mAHYBKABAKgBgpOGZ7ABAQ..&s=993970953ef8372e4e509a487d9bbf7facf8005d&event_type=8]]></Tracking></TrackingEvents><VideoClicks><ClickTracking id=\"adnxs\"><![CDATA[https://sin3-ib.adnxs.com/click?GCXoL_QI5D9UKriKi1ThPwAAACBcjwhAVCq4iotU4T8YJegv9AjkPxx-NsNQxL5kFiV0cwFY0E5yJKNeAAAAANEs3wB0BwAAvAQAAGUAAACCieEMF_oaAAAAAABVU0QAVVNEAAEAAQAUvgAAAAABAwUCAAAAAMgAzyEHzQAAAAA./bcr=AAAAAAAA8D8=/bn=89165/]]></ClickTracking><ClickTracking id=\"adnxs\"><![CDATA[https://googleads.g.doubleclick.net/dbm/clk?sa=L&ai=CWJmbcCSjXo2lBIKhwgPh9KrwDIPF675ckf-YvsUL-C4QASDml9YlYMnu7YaAgKAZyAEFqAMByAMTmAQAqgTcAU_Q1ZtkybIU6b611BqqfQUNgtNNupArdboxeoCw8SpS36EcMCjzRuhsP7PEhnpj1YT07GMweTarS-VfwCCFNsS_1rHWKTLIIJwPeKYVwywOxbjtD2bWYSp0ucfL67GfqAS8GR_0srm3mJEYbX2LeYfSOV8wQPFOuEGEEY7Ugm1wHDYZsr7w9F-_RDO4fp1g-q2P9Q54KxdAhsRVUQ5hBasTifNQRVY8Lqw0tWqOq6Bv2CDBZF3JEpCa71blG-YsyQkBDNZ3vpTpGDjmov8GLx-gifn0o0FdJNF096DABJOusYP_AuAEA5AGAaAGT4AHg7mltwGoB47OG6gH1ckbqAeT2BuoB7oGqAfw2RuoB_LZG6gH7NUbqAemvhuoB-zVG6gH89EbqAeW2BuoB8LaG9gHANIIBwiAYRABGB_yCA5iaWRkZXItNDA3OTA3NYAKBJgLAcgLAYAMAbAT1c3XCMgTzsG6CNgTCogUAdgUAQ&num=1&cid=CAASEuRoSjVKlW5EWolt00cBpAzOsg&sig=AOD64_1IyDULrpuhQLeExjG7nf0XgGrXRw&client=ca-pub-3076890012741467&dbm_c=AKAmf-DCv-INwT6XcFOl2cbINh2mhBEeKk1kt1AVKIs7K6h2esWQtz_x_cFLecCwbLOHVVz3URKL&dbm_d=AKAmf-CxXC890upu3pL-RPN3wlEGagQU_ITo5HUIMA06XT0ObgshjFeRIvYtigPwwwoFC5CRXl_kdBHug1TGaRgIDY4INQEsSAnWAQQKE9LdWYp7bX7sPjsAcd9sZ9JYgOfoHQAnAufSKmroAYawZN9lGq6J6M0I9haS5lM0rVzr0VdkAH1pSTWddTtB1UDZ_Fq9K-PMRuhgLHYStu3rmRhBIBMJ_D02Gex8O62yR15LUViABIhfhefaFl3x5j7B4jn9B6xfuibZOgaiGtrXGIpVd3e324nbPAfQxEHSfDTP3lEFJo0XSgsNSVT006RQIiJwZOfvbO2oFRR_0JfVq7MtWACxuXeNuQQfPtyOFe_qQ0vpX4f7MGe7L40Pf1A0fmxM1tNGpIOUAM0rRfB9e6M0uig68y2kRJU5RlxIFfx09BNzLAdG-gPN98yAOeqNBnP8Uv9x3IFS0PRsTWG_SAo4t3S3mUnW9Q&adurl=]]></ClickTracking></VideoClicks></Linear></Creative></Creatives></Wrapper></Ad></VAST>"
    },
    id: "vast::37780:0000afb8-3259-4e98-afc6-3f79e2ff2a47"
};

// VAST -> Ad -> Inline -> Creatives
const pubmatic = {
    "VastBucket": {
        "adUnitCode": "ADP_37780_300X250_623aee15-b53c-4a4f-8f8d-e83eeb9d2f1e",
        "bidder": "pubmatic",
        "cpm": 0.009000000000000001,
        "docType": "vastdump",
        "id": "4e82c340cd084e",
        "originalCpm": "0.01",
        "pageUrl": "https://www.javatpoint.com/symbol-table",
        "responseTimestamp": 1587788033479,
        "siteId": 37780,
        "size": "640x480",
        "vast": "<VAST version=\"3.0\">\n<Ad id=\"1\">\n<Wrapper>\n<AdSystem>PubMatic</AdSystem>\n<VASTAdTagURI><![CDATA[https://bid.g.doubleclick.net/dbm/vast?dbm_c=AKAmf-Bf9thDBNPJLowyF15WFrBc1Rr7enKWbHHwqwv6vr-uizxneLo1Ce3w9FSB4pFd3n-LDYf-Fbf6-HUyxaGoXDZKGr4HdQ&dbm_d=AKAmf-AGzCZ69u6_zgZOczeraUblUgAGs1KksFcUsqIVCHSfBQ5AVzUGv3Tx1yuQQmQaGCIuTvoGNqlvGI1YY5qTZY467G1i7KwdqDATiXMJk5Lly8H6sGCWgEEUw6s90PxqMAJfcBYb-hcrnsR0o6kaRbRa6tuUeEEUC82iYEOTv2Spr-IbshGs8RSs2VQ7k0DvmgUd6cCDPC3Hy28JyRUJVjfe060PQNenVvGH-tSCYxvKekUDZfOaUONucIo-wZxGXqOerRq2dqVIYezVm0i617X7lo-hq3TwcnbnwzFKLZXpCFsJH6ezYWXl1cCddBoXI4f510Y5ktf9gH7ZcaOSOQi0WHqPQSPYFDjg22AYAAUOpRCX5SSM6GbihijBdnhZwpIPnlT0M5dyiOMkpjX1z7O3NnUvLhbwL84NA2Ibl6Y-WguII1f7y47Qukvflq6harwZE5RlCriVBwqsI6fh1w61qTQMbRGfTbi6ff5DhKioRcDDllppULQRYWzfKLcP9VFnQdMHmVKfU4ThhdvOXjc9JPBA2ovvP6wJ0KHHtNOTvU7GzxNQWMp7o0R97NETyvVG-dPbmvX3WfSM6COBzP_zgaHKt4M_TJgtz6ek9JatJAJzVfAdTetEz0jxN3Qj0NnLHiW2-KB8O6HKqZi9MB8GeJapWCUP4047bgwtctMOzqnR99lpLKyeSVtTdtVNVtvwWm-jQPeCiL3V9tQAhYOHLXFxECeaUMLIYvMjcT3A3_ZyQYxReAdGSIT6osvHu62lkmBprihi5_0ShaHvcVFMGw3ymppMiRq5xh0_9bXW_tWKB_Ve__ZyLBzHh9-bY9Oo4IxnjOUIoP2LmDtIuepsYPDrOoKmfem-KEQE0rKE8j5-mzOMg4mRUC_snanDuFaFmiEBpFRQRAxrT--1i_PSnYL5J4tGroYZPxEjD1dsgjiCGR6SRjokjKfpzFWeSzQ0RjJCPmAiF1g3IQDnBqQs_1RvGmkeoX6vTYKBamSeXOfn5X3JFbNUkhuek_F_vnXGkVSYnuzEl4knuVaPG-CJeq91UpAJX6M_Q8q015Ywc2bXC-qXfGk8lBOIAVVTB78wkR-860Na9LV311MirVS9BeRICKuCa6HIPjfnOvKD_cfDu0Yh1W-f9_1MTIbTM7aHPfgeeF8XE5NVsq04ZlALPSinuptrHyCyhCPyJT5WgOTt_N4Yd9Qbg1egc3OVPAsNml7FjAQ_ChIaAXHUWO9x0lJmnN9gRq0Np_AbkqnJXewsFTQS3JD4VPyRIIWQCHelIPg2cqyeWwQOLvE7v9EdsYEJ1DIs9nazoBWrS-W5jWh3UJ3jNTsrMAbmTOuYEcWN2x8IN0_4nAotkxrOnmKSOLLg9Xtq_Xexh1w9gwctmbH0OAVrR4XsgdSVxpL0lPataCtWHHymu_aekOcWil3wYlNnLsU-y-HL-bmNgdk0MWnuaJbm9wOkSv1i46rc7ZBaY-VC43NOFFD_Y0wBRYiemlDjlEKdJ3p187sBeJKQ1OI5S0ibXOmq3QNY8wXHjtSWQLpR5QN-4BT8jiiTBd2P8mA-mF4msmKRX_C2Z-1E-Azo7BWwYgInCT3yf39csV1q55NfgRgUXbcll6mtv9Ok7MROVnugbYSWtFegOVpSPXH39hYm-ZUi4cTXMnc75_X_ePWKhSGNarsJYlLSHtspGI3x-NDXoE9Yz2vyX_b2tj1kXgkMvIa87NU5wZBS5to0pNxtwQ-RIA9_FrnLhVmWM2aSr0xvKbW3zPjF2QCo8rWpmpOlLFVgoOu_bm21FOflGAGYRGrS-wAxwYdpDj1HnxFVaLRp5llgOuWtXSRFAEXOjEz9BDISCDUMwJVL34O50ijTkiU6WzMl8uMdoI5Tvdsz25GCYgkMMtccW6xdfdsbBzmb1zgfBjLrBlqsg9Q-IgMR-w-zhxLUVZXHc2R5NAZZPj-4uzxO-s-2pCHdo9Ry4EkzZwYunhv8efgi3H0KTDjs9yeTNzlsENiLmXmTzumQWQctjpphdPCvmoaF8j-eKYlpgmQU-Livt0Bzz2JzQM9GIHFDdCCFrt91Wp4IK3j0uyvEzPAU97hgt72pXSGEvRe14dyiSzmbeWbvtnZRjACbuAHoPT800pIW9g-YlW-4jwwph01hf1c91hh-zHPLRaalAX8_Re2IvzXsYtlG10RhEs1OuiTNFHr-Km3bnG0tIGopuCRh_8uIPH1ICZLeRzsPHJ5wgIRs3MPvnnSYkU-oH_oq-Po_Wvr3BTcTklpSKC-L5cw3ZS21L9U4Fj7nJywOvdGOLUg0WXqi_pUz-irUABuIUQHQT4IaYKZ382C5gxrSc4zDdXABrjDu1E-gR_Lm_2gH_j_tra3hCk8xtz2oWJnxZcbXOZjNlEAqeXlnqGruwBcmwx-P8D15lCdbucQUi5FvdTgczqBGkme-LpOdX1Yx3BAI7yy8KkVWHDNqO_lPmCaQgjhGI-TU7jONQSvQOVkF3UIPRXlqP1PyyGgamozfmgwZ9fzcbVy6D6rc7i3mkKAmDGycqsLpJuIKXn37hoQCtPJYHVVAFRtisQYEDgm1jVXAAKiDGk7HPqCiDIhdgzX6PCJharFr-gl8hOnf0W26ykBzZ99rTuZZ5JrjajL3yz1BinNCl8_tH1mNhawSEBU3Oy49KzCfEAxikcryZvjPyMJHrP3EI6bhFm-Je3HI_hT0_PXBXtMMHQB55ofinnvYsOMxd0Aa78wn5mg3e6yh1ubE24OWmyLgv5n8ut0W35QsPv0sa3KAasM6iTkxfgPBS7etiEFDt1DqczClhcUsC3cBv_NkO-mQ2ck-VPxQYHAuhPHqBc1SupHnMYETbsB4MdF104zbH0bWv_d9-SKVHrVRQ-Qc0pBQHfsI_04PD8rs2v6INLIK14JFhHmq4EZBKlZKMyQ9TmHXkQR32bX2kYGJRhcvCswZ9OAEq8a4PhoGfULTJ3k9M8XNPoXNbH9htk8zp9ettz_u9vq3NmM1i9knUTe2YRPx9Jk_Kep8ZhvCn0V7qku8NN_BCDvLvp8clfU9t-q7BetxBgI&cid=CAASEuRoQsosfwa0qDnk83ySm72ilQ&pr=6:0.011400]]></VASTAdTagURI>\n<Error><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&er=[ERRORCODE]]]></Error>\n<Error><![CDATA[https://image8.pubmatic.com/AdServer/ImgSync?&fp=1&mpc=10&p=158261&gdpr=0&gdpr_consent=&pmc=-1&pu=https%3A%2F%2Fimage4.pubmatic.com%2FAdServer%2FSPug%3Fpmc%3D-1%26partnerID%3D158261%26partnerUID%3D%28null%29]]></Error>\n<Impression><![CDATA[https://aktrack.pubmatic.com/AdServer/AdDisplayTrackerServlet?operId=1&pubId=158261&siteId=577248&adId=2123317&adType=13&adServerId=243&kefact=0.011400&kaxefact=0.011400&kadNetFrequecy=0&kadwidth=0&kadheight=0&kadsizeid=97&kltstamp=1587788033&indirectAdId=0&adServerOptimizerId=2&ranreq=0.1&kpbmtpfact=0.011400&dcId=4&tldId=59369291&passback=0&svr=BID55002U&ekefact=AbmjXrYjBgBUVvZePTtmSuT8NloCx6gls4loCG6EF9KQ6vwO&ekaxefact=AbmjXsUjBgDxEt4eKPQhvUnqAqqEnd-EExMjz7PxkKsgKj2i&ekpbmtpfact=AbmjXtMjBgCQ-rWcudndOUfikn8hqNLvIuZr9WFjb3is8n8u&enpp=AbmjXuAjBgC5-CO2JIldyUo-qR7Bkz5LGfWP6caHTbmYXYsT&pubBuyId=10383&crID=230513102&lpu=oracle.com&ucrid=5585303614060744721&campaignId=16514&creativeId=0&pctr=0.000000&wDSPByrId=333633&wDspId=80&wbId=0&wrId=0&wAdvID=8930&wDspCampId=35936783&isRTB=1&rtbId=CDAB40C5-208D-41C6-A607-268A3A1EDA50&imprId=61C3B14D-2BE4-4196-BE17-98315F23A82C&oid=61C3B14D-2BE4-4196-BE17-98315F23A82C&mobflag=0&modelid=10678&osid=216&carrierid=142&cntryId=107&domain=javatpoint.com&pageURL=https%3A%2F%2Fwww.javatpoint.com%2Fsymbol-table&sec=1&tpb=0]]></Impression>\n<Impression><![CDATA[https://image8.pubmatic.com/AdServer/ImgSync?&fp=1&mpc=10&p=158261&gdpr=0&gdpr_consent=&pmc=-1&pu=https%3A%2F%2Fimage4.pubmatic.com%2FAdServer%2FSPug%3Fpmc%3D-1%26partnerID%3D158261%26partnerUID%3D%28null%29]]></Impression>\n<Creatives>\n<Creative>\n<Linear>\n<TrackingEvents>\n<Tracking event=\"creativeView\"><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=1]]></Tracking>\n<Tracking event=\"start\"><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=2]]></Tracking>\n<Tracking event=\"midpoint\"><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=3]]></Tracking>\n<Tracking event=\"firstQuartile\"><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=4]]></Tracking>\n<Tracking event=\"thirdQuartile\"><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=5]]></Tracking>\n<Tracking event=\"complete\"><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=6]]></Tracking>\n<Tracking event=\"skip\"><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=7]]></Tracking>\n</TrackingEvents>\n<VideoClicks>\n<ClickTracking><![CDATA[https://aktrack.pubmatic.com/track?operId=7&p=158261&s=577248&a=2123317&wa=243&ts=1587788033&wc=16514&crId=230513102&ucrid=5585303614060744721&impid=61C3B14D-2BE4-4196-BE17-98315F23A82C&advertiser_id=8930&ecpm=0.011400&e=99]]></ClickTracking>\n</VideoClicks>\n</Linear>\n</Creative>\n</Creatives>\n<Extensions>\n<Extension>\n<Meta><![CDATA[name=pm-forcepixel;ver=1.0]]></Meta>\n<Pixel loc=\"0\">\n<Code type=\"1\"><![CDATA[https://ads.pubmatic.com/AdServer/js/showad.js#PIX&ptask=DSP&SPug=1&fp=1&mpc=10&u=709A3C13-9D9E-4031-86BA-44E5A49A6898&p=158261&s=577248&d=4&cp=0&sc=1&rs=0&os=1&gdpr=0&gdpr_consent=]]></Code>\n</Pixel>\n</Extension>\n</Extensions>\n</Wrapper>\n</Ad>\n</VAST>\n"
    },
    "id": "vast::37780:0000487b-7b89-4a31-854b-11dc10849032"
};

// VAST -> Ad -> Wrapper -> Creatives
const oftmedia = {
    "VastBucket": {
        "adUnitCode": "ADP_37780_160X600_8b476cee-75c9-4caf-a662-cd49b79c2ba9",
        "bidder": "oftmedia",
        "cpm": 0.1726614,
        "docType": "vastdump",
        "id": "227ae0597fcfb1a2",
        "originalCpm": 0.191846,
        "pageUrl": "https://www.javatpoint.com/operators-in-java",
        "responseTimestamp": 1588001456847,
        "siteId": 37780,
        "size": "120x600",
        "vast": "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><VAST version=\"2.0\"><Ad id=\"198077494\"><Wrapper><AdSystem version=\"2.0\">DBM</AdSystem><VASTAdTagURI><![CDATA[https://bid.g.doubleclick.net/dbm/vast?dbm_c=AKAmf-BdENT26wjEGAchjLPf8wg_bmXvtQOlJMRU1wtc8H42Fstj5qKkjK5Z6s9qiEXvJSgyO3qV&dbm_d=AKAmf-D-CncJxs2j0nA3rsxnw0foVBjCn9i9W85xXXyvYGlLh6UaafDWTUlz5Y7TGOofOOD2jgP-W1Fi0emft-itKrTao2pPgb2ZYD_aYzoMSDWtZiSURyBpKeY74xZKF8vawrNGevLuKuXiKYTxiZO9olBEtjR4V2VOUib2zIr9yMLPvkehRG3ExkqWkSGyNplvnc_MDOerM5U0mREHcGP3U6hh2YXmPe7-yfkuRMVSwPEW09jdYvI2u9M9M-VgK7Vo_--KvtUBpbOgPTqxtUjzQBPMLZU-8tiGVkDvaLZUbRkG7h1Zzk2GpkiyUIb6PnaY3b0towg70VVLTsqJ_Jnhu1ynPiPBLjIwgNEmtfzzSLI2zLXWEgOpiJRncYW0wTEA-GcYd4ynYew20dbcwrHkqOfPeurq7O6Yd1I5ThkPo2-S4V5QxrIR0q18KtN8rrq_WT2IZ-laQ3Oxo6XBROeR_BZWn5eNAFE38mNNW2XjAhbjYJVoScZDNuKVDdKeazRCGx0jAjvuRApZcyWVU3RFfRRUhkZO4KLtXv8-bIlovkrdEKNsg0JQ46dyObLQZtKDX9MiBtYNbvLMHhRU5kRKhV8NtGjx4zZqs866_bu6WUI5tmfGV_Im3rTP2jF4MRRVr0_kVkquCgvABEppNT4QNqCSjbMZjS2xMZCqrBgOS2JF7HZpvUrt8rJGC8TlaZZT6DKfNO6wjhkBPYbXM9z7TVk7lFjQ8AinUS0e9ghV0vz6bUX-IFsk24VC8uYNajoJAnWdZa92tTfmH5yjot47WRtmeQTkPhJHdA50SMb6i4cexrJUK0KPJwQqmJ9An07IKWi8kfRBo1HT3mwUpi6iuqUp2U7uAPsqvT7_unagFBzhXzr-KzDsC7j8w6o1b0ekSFZj3KpLhYVmfIlMCV4Bi39BYp2wIg4azpTSsi37ge_SMC8_3J8rpMSyXqU4alxTOHSAz0GWgjorn-OtFhjVFi14tN9qjcNnICn2VQcqr8f4u4qlGdhc1Uzr4tba4G2lvFDfO8VfVl4BjTGST14PPMNf6JgtM6ikp9Vlfgva5CiMwB6YYxXCF1izcf7Z3d319SbmvDMUnHpEEJREdxFe_1DEql6LymqMOG6sWgyQALUDYHymVh1-xZIQ_8_uzOigEhtpH4mZAqkk0HEJW2xU9R_oCmBLrpFl0VNLnMTS1GqdCMJKw_KJSt4Gv7gvSvAhxtumLWJXUFNeHmy2S4IKdsekKa-hcQMwgIJL1VxlMomBPg18NHWWkwGzLKEtmUwGSSzYiaMtNC_6h5t7Y2u9YqTPxUlBjrioc0hVQd4AP2uJj6xE77sQ3F_jYLrvCbIdUoXe-ZOwI4ctQm8ExZCfPUCcqavCFcvKtDuc1y-iUs5dE2DrWr5K59RWJwLs0kUWFtbZCoqgyVDS-rTYSmwu6wsFPttjowGDaNTE_ug43L4suO_iTvvxKZPCpTmnLc4NWc6AtXGFKSrIqGCEJ0H2vNooTCAzYRIsReq6U-QrAQcbLDvd__F05wQq2RlW9zzVanv75SigT6UPLPzrgRhf95lhFXQUifl0miJo0WNUjUgJOOrvj3F6f3enCMY0LflonJFxvebW8DmHcQSh1XkrgDpdT0NPS3TTYVXN0UET8QfxXlje8rFqD9NdZVuFQt2BZZBWrAJ1i36e03Sda0THgHPwsgTwAqfEpCfuPCs6JmfIr5Le8uOfgPGd843Ryv2DB7IIXrfJU9TQbiODSatxnOHYQoVDaGzPG9YlPuvB-bROqM0NZB0Ze64ODfDQt9j6tkCDrNc4PltyxK81ZGF3Hja3d2Dcyqma1Cz6DBWi-Gzq6_YONnzPwRtrWY7QtwxX1OJxQUklwSJjk3RZZN6GyW0ymv4qsN8jSMWgLsx5mI2f4VX8T4up5RNXPC47uvnpCqK7i6N7MMtEmtlwmLlXqpp7mJhW0b_BgmnhFMFqb5KN4M92CT24hDsJ2ts9p3xsgXPHPp2yh69lwWf4ROZhuMRZR-BfTl1YrlxDUFOVyBu7Wu4ji8jeQwgdXOzByzbBCNgr7OZgko-fC9qh25bebwY2RrUNTeNLb003K1zwm0RReJbAqG1C4K36dR7AaQcMpn_mb3AY9_zWbWrw9EOGz8kVfdst0bKjcE3pYsPjTJaJRcd3MPY6YjgQnL-Z-RZdZENBIoH80ti8ZrYwtDUhmKa5iU7pIfRmJ3QUvAmV9ndI7OpozyLbgR_tsUs4So2FZf6EmoFrPtAG1lZHL579pZfrRkx1Cseo9CtqNf08zS_8I1jwNjPqLNHe9qJaumowOqSaSn4OIH_9CPY0WaLEZaad6uZTt2C3Rq6BmaP47WT3lViSvkS-9JwEkRP60BS7kkOsrLz3reCzjf8TkWUPC9oCXD-U5qsx0U6XGdqgPpOa07e5rY3p2Js1QzGpeqndfJBv9AmN72KFI8KgxCkyiw3SZRMVgMI9ugjwb3kl3IH2BwuyXf524mn5dX4-Z-vmQ5ZWco77c9jui0fqhGlDcTjtIytcdGZSgAJNPnHcJ9hd4PZrta3wlUa4CLdJFHLJkL3Y53TwP72rJ8mx7LH66_Kl3gGUBEMI65XsnpFYf_Dh0NzZDCjJcboMj-bklxVG2RSgk6QN9Mj9vbif9Jis1YdLti7y7ArsZTSWIQJCX_0QgGayV9e_VvJLPSieMLwyGu27KiNvSObH-VJfruF70qA4gHKyV13tZwUveNw4Nld6PBNXPQGofUWG33-O5Jwm6mrduV4eY3qZxZ7BOqukoHWAaH74Ng&pr=10:0.225701&cid=CAASEuRolUeWtpmtgFrqwBghwLe_Sg]]></VASTAdTagURI><Error><![CDATA[https://lax1-ib.adnxs.com/vast_track/v2?info=ZQAAAAMArgAFAQmy-qZeAAAAABELl8Fp7_n8bhmy-qZeAAAAACC22LleKAAwvAk40RhAiMpKSLKM-AFQvcr6BlhsYgJVU2gBcAF4AIABAIgBAJABeJgB2ASgAQCoAbbYuV6wAQE.&s=472e51290c73b33d551aa9e79d584a14922871ab&event_type=4&error_code=[ERRORCODE]]]></Error><Impression id=\"adnxs\"><![CDATA[https://lax1-ib.adnxs.com/it?an_audit=0&referrer=https%3A%2F%2Fwww.javatpoint.com%2Foperators-in-java&e=wqT_3QLOG_BMzg0AAAMA1gAFAQiy9Zv1BRCLrobO9r2-_m4Y8emaqujUv_JRKjYJ41XWNsXjzD8RAcnPoWeOyD8ZAAAA4KNwD0AhAcnPoWeOyD8p41UJJNAxAAAAQDMz4z8wvcr6BjjRGEC8CUhlULbYuV5YuodeYABo1bmIAXi6pgWAAQGKAQNVU0SSAQEG9EENmAEBoAEBqAEBsAEAuAEDwAEFyAEC0AEA2AEA4AEA8AEA2ALnQ-ACk_5Y6gIsaHR0cHM6Ly93d3cuamF2YXRwb2ludC5jb20vb3BlcmF0b3JzLWluLWphdmGAAwCIAwGQAwCYAxegAwGqA9IXCpwXaHR0cHM6Ly9iaWQuZy5kb3VibGVjbGljay5uZXQvZGJtL3Zhc3Q_ZGJtX2M9QUtBbWYtQzR3WWVBWEY4QjNYVzl1eVJiZUdHTTZ6MUhJOTFiN0pWdkoxb3JZcG8yUmFKakpFWW54TERWYjNuSmVmMGVtNlFZTEd0eHRBYXFQSmFwTjVIVHVlMXR6eEYxYUEmZGJtX2Q9QUtBbWYtQXI2QVZ1QVRuNU9ObU9XNnd5TzVkVVd3RTd0bFhoMVlmdHZUNUdLUjZUTGNKcloxNl9YZzczMEFzN0tjd0c3MnN1MWRuVzFpa2k0d1pYaTIza2dLMkp0VzhOcFJUdWRCOVRQZXJtNGlMeFNPZjJwb2UwcHlqazdOcVN0S29TYnp6OGJ0MjVFWkIzazdZMmxuWWtiM2lUdGRPV3A2YkpqUkM3YlhDa3p1ZnMtbFFqYmptQ0hEYkh1WHk1SXZkcmtUbWZPRFdhVUtqN1djdGJITXlFRnJTZVpBeTBYTjFRTFBSX3Ywak53b3hWdndISUt3eHFYbmUtUlBkMURPeURwclBuMWNIWHRkQ2ktNUZqVWJzbTRYTVJicnFOMUYzczNPR1JycndQMnh5eHZZbzctRldxRWdKMGRRNFZZYmZ2d0pMdjhKbUNYMDRZaVBSSEZRTnZ4dDNkZ1B5QmYzSmowclZaSHJDYzd0RkFCM01vRDBmeXBiRVBQdUVIblJQMmw2S2RYQjJfNG5lQmN0bzJYaFdIak92ckx2a1VJcVp1X0FRc0NfdG1BdjIzOGhyTGlKajRsbjBrYVpya21YWVZuRC1lTW96aUIwVVlUZHFZdFo2amh3MjltbGYzTy00MnQ5dWI0R1RqYVU1ajVLM0dhb00xXzd1VjlRTWZCZGt3TGJVaHJZcXotcFZ3RUFRLWU3R1djVUY1Y3FHS1B1V2Z2UlBBVWRNODZOWVRoMndGSm84QzhmTnFkQkZmQ3gtdzRRQjg2Q25lcEhsalJkc3V3M3dPdEc5a1FFVUU0TU40T0RNWktyRlNLTlNPcm0wTTE1V0JqWVZFS0NiZjFyY0NIYkVmdE1oQVcyTnRLX0NaUWhfd1puMmNLMEFsang2eWMzNEVxYzdQSWNzdGFCLWQxR3QtY2Q4dDNuQUlWR2JCYXg2azJvUXJmR0tQR3NvLXluZ3AwbzdodVYteTlNaHl2NDN2WVJJWFZUdXBWaG9aUnFLRDE0SGNmQ25zN1N0Q2hldnFGdkNWd0xKeXM2U1ZvZVRKdjF3aThzYVJZN25ac0k1VVNCZjZzeFZfa3FoekdMWXpXdWZwaUFtdUF4QkNaZEhDNEw4UXFjbi1wTlFiLVB1WFF4ekhsRjlYRXJVMTM1anpJcFEtVnppVjJQd1FaMGhpYmxEdUdXeHZKLXlPSUJuMXFGbExCM25MU3RxdzM2YzBrNmhHMWQ3ZXlhT3VtTjlYM3h2M3VGb3pkMVZtazhNaW43MWlfT0pkYlgtODViV0ZVZW0xREE3OGFsVGhlUlZLTEJhZ3VmVGFlNEozNTZkNmppb2lWTU1FbmFlazRtTXpsTXdSTTRhSU4tdEVlakQwVGFKWDR6T2VCdllmVmJXSWxZbzBQN0dOd0VOc000MDdnRlNkaW1pSVFPeWpVRnNub0phbjlyV094S3RwRUx3bnhzZXpJOVJBVWN0SUpRemkxakVMcTNfMUMzSWs0VWtTVHB6M25RTmdmS1BTNUNYODZFTHU3TjQtNU1WVXJWUXIyMkFUU3JGbzVwOWxQX3hUZXRzcFVIMnk5UndGQkMyUF9OMURUdVhxMlFBQi1ubWpkRHlUSmgyd2huaTdSeTdZRXBNTU50dUlUM1ZwY2xaT0pjWVc0bnFWX2FWbGZYbmI5bDNEakd2eTZVZFp3ZmpNYVBoa29UTGxpakdWb3dYM2NKWGJmYW55b1hEZy02cW9LQkIxSUlJb0J3Mm5mQlMwT3c0V1ZwZGlYT3J0WWlpOElLWTNSUlJRSkJ2ajE2VDNKVXZ2c3lDRklRdE4xNVhHMkFyc0RhN0FNajBXREdKOXFFOW5TTTJMYVBpT04zcE0zdXJSWll5QVM2THVfY1dsR1pnN3huUUZ6ajExUEsxbGtXZGY5bzhEM2E5RHNWcGRpRWtvd1M1dml2SlFCTWVxRlBnZTU0NTUxSXpqYnA5ZktPaVk3cjRRZ1Y5Sjg2bktuN3RGQWc3WmpHUHZ2WU9TWUo5Y01aNXJrWWl3R05aSVpEV2FQeVRlYzV4N1RfMVB2WWdqMXI4N0pPdDRvQVhwOF9ldXMtMmIxYWdEQVd5eVFlMjRCc0NrQV9OTkJIRW9hdndrbkd1dVJrZW1iczZSTHFzd0YwUHpfS3c3OGcyS0wzdEpDSDBiMTlUZ0VxdUJldHZsc0g3dnNLN0VrUzk1S2dpR1ZkaEJKSnhVN2JvRld4S29FQU5xNXBMT0taMkNpU1FxdW4xNUFDRmlSQ2NrbGRmQ2FVa3RhVHl6U1d5clZnZ1hGOEtSNUtqRlBIbDc0a29tUzdXQV9qaWtGdTYyT1VLMUJ1dDktTzNvc2xGZVdXczJ1X3VXcktNaktjcGhYRjBHeklRaFB4RHhYLWFUdlRtMVg2MHZVN1J5cDYxU1gzWUl1YlVLTzdpV29oRXBsOWpuWHRUdFJEcktTQ3BYc1ZxVkV5bTZGekdDSDF1MGVSVzF5SlpvUjRrcWdaYVU0cWtJNU96Mk80RHV2M1BVT0dZd1EwZlpNVkRWRWtNX3MwUDJTZ1JGM0ZSc2ozeTU2aUt2R0VsRmF2NXc0a0oyTjltYXphdzZ1SVpTRS1uTy15Z1A3SXJKYU95Y0VVYWJ5VVpxYU1HTllLOENBTjlpWmQ5SWxaTnRTTm5MSFU0Ykd2UDRXZzNYU2FMWGw1ZzI2R2w2WkZTTmczSUZEYWZnR2NNVVZaQ0lrY2RmdmwxWnRwQXA0SEhkRjVKUlhISFI0SGU4UHV2emxXZklfQzl6ZXk1LUE0eVU5b3J4Q2lzRWhCeDhfNGVkNnBBT09Vd1A2NTdCZTI4RTNrYVFzN0ZNSEJ3ZWN1SnJwRUJtOVlUakRCRVVnbHRKOWNDYWZvUDdCQzJSUWtZRVNCUVZjbFRGVmhPQ1FGZ19iN1pqQUFBakN3MS1RbmVNX080LVFsaXNYSnE1MlZaUUNsX2ZGb3Z3c2lWZmhPWWdrZ1lKZ05GWUNXUHBSREJqV3VyRFBOSGlWLS0wWm5KVHBXRldBLXUyR2gzSWxid3ZmbnlIemI4eFRzNloyanBodUltSzZKTXBnYWI4ZVJVZmxJa3p6aG9kQ3BQZ0N2T1BVaFBxRVNyaTFYNG9GaGY3UXBhbXZ2aUMxYldMR1BFT0RIQmd2NEZZbENJS21CamFNXzlicGJua3cxZl9uSXV3MWREamd2MFd6clFTVmlUWS1KMWJwd0s3QkpHTGZqSTI1V3JyVkM0RTJLLVlZblk3bEtQREQ2VzRFUUVxUHdJRVBRUFNDSzFaWmVVUWcxa041WFdydUNNamc5a2RkQzdkTWVYeURxTjhIa0QtTy1QNDlBdTB4ZDFzX3M3U09DblV3YXdKZEdodUFCM3dEckRVOTBBaXQ5bDZVdG1GczJVaEhCeFBzbXJNUTNZdWczQjNZc2hDRTlIV1ZacnpXYmQ1eTVlM1FsR0NHQi1ST2JwS3JuSEFsVGtSdUZRekVTSUxFNEZsUlBLenI0Vm9aX2RYc2Q4ZF9JX2c5WnUxYVZXcXl5SmswcHd3cDdIM2lmWUNmcm5ibFdQRXhXa2NOaUtvalhNRDdjWVgxLXAwS3VCRzk4d05wdm9Sc09rZ1RzVml0Y1pXWmpOYm1QRl9TNk1OREhDZkd3VXQwQkhpRVpYVkNKVWRSQ01YajRCbCZjaWQ9Q0FBU0V1Um9sVWVXdHBtdGdGcnF3Qmdod0xlX1NnJnByPTEwOiR7QVVDVElPTl9QUklDRX0aEzc5OTc1NDE4NDQ5Njk5NTMwMzUiCTE5ODA3NzQ5NCoGMjAwNjM3OgkyMTM4MzcxMjjAA-CoAcgDANgDv5s04AMA6AMA-AMBgAQAkgQNL3V0L3YzL3ByZWJpZJgEAKIEDTE3MC4yMDIuMjIyLjKoBJSHAbIEDwgAEAEYeCDYBCgAMAA4ArgEAMAEAMgEANoEAggA4AQA8AS22LleiAUBmAUAoAWHjYXd3Jacrh_ABQDJBQAAAAAAAPA_0gUJCQAAAAAAAAAA2AUB4AUB8AVs-gUECAAQAJAGAZgGALgGAMEGAAAAAAAA8D_QBs-AAdoGFgoQAAAAAAAAAAAAAAAAAAAAABAAGADgBgTyBgIIAIAHAYgHAKAHQKoHCDMyNzU1NDExyAcA0gcNCQAAAAAAAAAAEAAYAA..&s=b9d4201c43d67841880a6ca08fe9d5bfb047c048]]></Impression><Creatives><Creative id=\"10906155\" AdID=\"198077494\"><Linear><TrackingEvents><Tracking event=\"start\"><![CDATA[https://lax1-ib.adnxs.com/vast_track/v2?info=ZQAAAAMArgAFAQmy-qZeAAAAABELl8Fp7_n8bhmy-qZeAAAAACC22LleKAAwvAk40RhAiMpKSLKM-AFQvcr6BlhsYgJVU2gBcAF4AIABAIgBAJABeJgB2ASgAQCoAbbYuV6wAQE.&s=472e51290c73b33d551aa9e79d584a14922871ab&event_type=2]]></Tracking><Tracking event=\"skip\"><![CDATA[https://lax1-ib.adnxs.com/vast_track/v2?info=ZQAAAAMArgAFAQmy-qZeAAAAABELl8Fp7_n8bhmy-qZeAAAAACC22LleKAAwvAk40RhAiMpKSLKM-AFQvcr6BlhsYgJVU2gBcAF4AIABAIgBAJABeJgB2ASgAQCoAbbYuV6wAQE.&s=472e51290c73b33d551aa9e79d584a14922871ab&event_type=3]]></Tracking><Tracking event=\"firstQuartile\"><![CDATA[https://lax1-ib.adnxs.com/vast_track/v2?info=ZQAAAAMArgAFAQmy-qZeAAAAABELl8Fp7_n8bhmy-qZeAAAAACC22LleKAAwvAk40RhAiMpKSLKM-AFQvcr6BlhsYgJVU2gBcAF4AIABAIgBAJABeJgB2ASgAQCoAbbYuV6wAQE.&s=472e51290c73b33d551aa9e79d584a14922871ab&event_type=5]]></Tracking><Tracking event=\"midpoint\"><![CDATA[https://lax1-ib.adnxs.com/vast_track/v2?info=ZQAAAAMArgAFAQmy-qZeAAAAABELl8Fp7_n8bhmy-qZeAAAAACC22LleKAAwvAk40RhAiMpKSLKM-AFQvcr6BlhsYgJVU2gBcAF4AIABAIgBAJABeJgB2ASgAQCoAbbYuV6wAQE.&s=472e51290c73b33d551aa9e79d584a14922871ab&event_type=6]]></Tracking><Tracking event=\"thirdQuartile\"><![CDATA[https://lax1-ib.adnxs.com/vast_track/v2?info=ZQAAAAMArgAFAQmy-qZeAAAAABELl8Fp7_n8bhmy-qZeAAAAACC22LleKAAwvAk40RhAiMpKSLKM-AFQvcr6BlhsYgJVU2gBcAF4AIABAIgBAJABeJgB2ASgAQCoAbbYuV6wAQE.&s=472e51290c73b33d551aa9e79d584a14922871ab&event_type=7]]></Tracking><Tracking event=\"complete\"><![CDATA[https://lax1-ib.adnxs.com/vast_track/v2?info=ZQAAAAMArgAFAQmy-qZeAAAAABELl8Fp7_n8bhmy-qZeAAAAACC22LleKAAwvAk40RhAiMpKSLKM-AFQvcr6BlhsYgJVU2gBcAF4AIABAIgBAJABeJgB2ASgAQCoAbbYuV6wAQE.&s=472e51290c73b33d551aa9e79d584a14922871ab&event_type=8]]></Tracking></TrackingEvents><VideoClicks><ClickTracking id=\"adnxs\"><![CDATA[https://lax1-ib.adnxs.com/click?41XWNsXjzD8Byc-hZ47IPwAAAOCjcA9AAcnPoWeOyD_jVdY2xePMPwuXwWnv-fxu8bRGhab-5FGy-qZeAAAAAD2l3gBRDAAAvAQAAGUAAAA2bM4LuoMXAAAAAABVU0QAVVNEAAEAAQDVHAAAAAABAwUCAAAAAMQAXyutWQAAAAA./bcr=AAAAAAAA8D8=/bn=86842/]]></ClickTracking><ClickTracking id=\"adnxs\"><![CDATA[https://googleads.g.doubleclick.net/dbm/clk?sa=L&ai=C-LblsPqmXu_SLKqznAeD77PYDaOlzelc6oK5tpYK-C4QASDml9YlYMmGgIDQo9gQoAGLnJj4AsgBBagDAcgDE5gEAKoEwAFP0EH8qLchXH_SeAb7X3_4ltffc1SbWcl5E4znLou9zejZEibxOJanf7s4ys1UWJoaUyJUunOs68Als0DOctpaydf5e9mZLT8-l1-xdSjxmYVppavzHMMo9Wd4u4u5mpVbFrE7INFx7igD0fAcvnu4saaJII4VG2DgXSQ8v8eeWwtRuplT3fxXSt0dJDTugoK5aeu9AVboVHWgvDBNUdiAtX_XdhuE7Fr2V7y4FA_Ka4Jq3ivGnGJhKogruftajXfABMmK6O_HAuAEA5AGAaAGT4AH3ePnhwGoB47OG6gH1ckbqAeT2BuoB7oGqAfw2RuoB_LZG6gH7NUbqAemvhuoB-zVG6gH89EbqAeW2BuoB8LaG9gHANIIBwiAYRABGB_yCA5iaWRkZXItNDA2NDgxOIAKBJgLAcgLAYAMAbATm6PTCNATANgTA4gUAdgUAQ&num=1&cid=CAASEuRolUeWtpmtgFrqwBghwLe_Sg&sig=AOD64_1CYvBzsrN3WII43jerFujKd3osJw&client=ca-pub-3076890012741467&dbm_c=AKAmf-CVWimcRMLrapykap5VVENyzHlIhOT3ibXYeNt3jQjzSv_NgONQD5IcoEcQWL7H39pIVznQ&dbm_d=AKAmf-AGi1_9TVYnx4m24QAMlEpw--WzxjPv4XagZEFpShpdkjXFhluloH52gXpLaBtVEjZi4dR9R6Z7GZxu_iRa_1gvCteoCaCQMLXOP7fUJihjA7g1epHIUKgq1LIObF7DmUBVEdORMPgUAl_vxQzxOscL64Nag5d9Ac9aDjJA95BD-WkG4l6rJoS7aD2DyNfWB3AZDCjG7EK4JBzQJDyHZVOxQS8CGB1mK_UWWp4kpJCFmFinuPow-13yCze6VHUcxCha2Pv2BnxfLTQioC8uAb-Uky_KttQ1cXD3hxRN5q9ZS7FiH1jQ1NedSjYdGeN4cKuIt4UYwbJOUcr2hz0aKVZzayKYt10seXqSjKO7LB4SMWatDT-f7sH3CONpaZCqwJvsv7Ghd6L0Zb8lZjhrr703etDmqiz2phMVO35SeGEaRGdszYaeTnWRnmknbZ40E3jWzh8V&adurl=]]></ClickTracking></VideoClicks></Linear></Creative></Creatives></Wrapper></Ad></VAST>"
    },
    "id": "vast::37780:0004e9c3-6c07-45b6-b31c-63c295d3580c"
};

module.exports = {
    processBidders
}