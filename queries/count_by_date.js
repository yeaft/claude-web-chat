db.tick_rb_main_5_sec.aggregate([
    {
        $group: {
            _id: {
                date: "$date",
            },
            count: { $sum: 1 }
        }
    },
    {
        $sort: { "_id.date": -1}
    }
]);
