import chai from 'chai';
import EventEmitter from 'eventemitter3';
import sinonChai from 'sinon-chai';
import { hlsDefaultConfig } from '../../../src/config';
import MP4 from '../../../src/remux/mp4-generator';
import MP4Remuxer from '../../../src/remux/mp4-remuxer';
import { logger } from '../../../src/utils/logger';
import type { HlsEventEmitter } from '../../../src/events';
import type {
  DemuxedVideoTrack,
  VideoSample,
} from '../../../src/types/demuxer';
import type { TypeSupported } from '../../../src/utils/codecs';

chai.use(sinonChai);
const expect = chai.expect;

describe('mp4-remuxer', function () {
  let mp4Remuxer: MP4Remuxer;

  beforeEach(function () {
    const observer: HlsEventEmitter = new EventEmitter() as HlsEventEmitter;
    const config = { ...hlsDefaultConfig };
    const typeSupported: TypeSupported = {
      mpeg: true,
      mp3: true,
      ac3: true,
    };
    mp4Remuxer = new MP4Remuxer(observer, config, typeSupported, logger);
  });

  afterEach(function () {
    mp4Remuxer.destroy();
  });

  it('should find the lowest PTS in video samples', function () {
    const videoSamples = [ptsDts(0, 0), ptsDts(3003, 3003), ptsDts(6006, 6006)];
    const minPts = mp4Remuxer.getVideoStartPts(videoSamples);
    expect(minPts).to.eq(0);
  });

  it('should find the lowest PTS in video samples with decrementing PTS samples', function () {
    const videoSamples = [
      ptsDts(3003, 0),
      ptsDts(1001, 3003),
      ptsDts(6006, 6006),
    ];
    const minPts = mp4Remuxer.getVideoStartPts(videoSamples);
    expect(minPts).to.eq(1001);
  });

  it('should find the lowest normalized PTS in video samples with wrapping timestamps 1/2', function () {
    const videoSamples = [
      ptsDts(8589925344, 8589922341),
      ptsDts(2765, 8589925344),
      ptsDts(8589931350, 8589928347),
      ptsDts(8589934353, 8589931350),
      ptsDts(11774, 8589934353),
      ptsDts(5768, 2765),
      ptsDts(8771, 5768),
      ptsDts(14777, 8771),
    ];
    const minPts = mp4Remuxer.getVideoStartPts(videoSamples);
    expect(minPts).to.eq(8589925344);
    expect(minPts).to.lessThanOrEqual(8589925344);
  });

  it('should find the lowest normalized PTS in video samples with wrapping timestamps 2/2', function () {
    const videoSamples = [
      ptsDts(8589931350, 8589922341),
      ptsDts(8589928347, 8589928347),
      ptsDts(8589934353, 8589931350),
      ptsDts(11774, 8589934353),
      ptsDts(5768, 2765),
      ptsDts(8771, 5768),
      ptsDts(14777, 8771),
    ];
    const minPts = mp4Remuxer.getVideoStartPts(videoSamples);
    expect(minPts).to.eq(8589928347);
  });

  it('computeInitPts() returns 0 for basetime 0 at presentationTime 0', function () {
    expect(mp4Remuxer.computeInitPts(0, 90000, 0, 'video')).to.eq(0);
  });

  it('computeInitPts() rolls forward when basetime has wrapped past 2^33', function () {
    const basetime = 8589000000; // near 2^33, pre-rollover segment
    const timeOffset = 583.595; // seek target after rollover
    const result = mp4Remuxer.computeInitPts(
      basetime,
      90000,
      timeOffset,
      'audio',
    );
    expect(result).to.be.gt(0);
  });

  it('computeInitPts() rolls forward when offset exceeds 2^33 and normalizePts does not wrap to negative', function () {
    const basetime = 100000;
    const timeOffset = 95600; // ~26.5 hours, offset = ~8604000000 > 2^33
    const timescale = 90000;
    const result = mp4Remuxer.computeInitPts(
      basetime,
      timescale,
      timeOffset,
      'audio',
    );
    expect(result).to.be.gt(0);
  });

  describe('video start gap', function () {
    // initPTS at 1.4 s, first frame decoded at 1.4 s and presented two frames later (B-frames at 30 fps)
    const initTime = 126000;

    before(function () {
      // Normally initialized by the init segment, which is generated before the first moof
      MP4.init();
    });

    function createRemuxer(): MP4Remuxer {
      const observer: HlsEventEmitter = new EventEmitter() as HlsEventEmitter;
      const remuxer = new MP4Remuxer(
        observer,
        { ...hlsDefaultConfig },
        { mpeg: true, mp3: true, ac3: true },
        logger,
      );
      (remuxer as any)._initPTS = { baseTime: initTime, timescale: 90000 };
      return remuxer;
    }

    function createVideoTrack(samples: VideoSample[]): DemuxedVideoTrack {
      return {
        type: 'video',
        id: 1,
        pid: 256,
        inputTimeScale: 90000,
        sequenceNumber: 0,
        dropped: 0,
        segmentCodec: 'avc',
        pixelRatio: [1, 1],
        width: 640,
        height: 480,
        samples,
      };
    }

    function remuxStart(samples: VideoSample[], timeOffset = 0) {
      const remuxer = createRemuxer();
      const result = remuxer.remuxVideo(
        createVideoTrack(samples),
        timeOffset,
        false,
        0,
      );
      remuxer.destroy();
      return result;
    }

    // I P B B in decode order, the I frame is presented first
    const closedGop = (): VideoSample[] => [
      ptsDts(initTime + 6000, initTime),
      ptsDts(initTime + 15000, initTime + 3000),
      ptsDts(initTime + 9000, initTime + 6000),
      ptsDts(initTime + 12000, initTime + 9000),
    ];

    it('presents the first frame from the playlist start', function () {
      const result = remuxStart(closedGop());
      expect(result?.startPTS).to.eq(0);
      expect(result?.startDTS).to.eq(0);
      expect(result?.nb).to.eq(4);
    });

    it('decodes the first frame from the playlist start when audio starts before the first video DTS', function () {
      // initPTS is bound to the audio start; the video is decoded 30 ms and presented 90 ms later
      const result = remuxStart([
        ptsDts(initTime + 8100, initTime + 2700),
        ptsDts(initTime + 17100, initTime + 5700),
        ptsDts(initTime + 11100, initTime + 8700),
        ptsDts(initTime + 14100, initTime + 11700),
      ]);
      expect(result?.startPTS).to.eq(0);
      expect(result?.startDTS).to.eq(0);
      expect(result?.nb).to.eq(4);
    });

    it('does not fill gaps of segments remuxed after the playlist start', function () {
      const result = remuxStart(closedGop(), 10);
      expect(result?.startPTS).to.be.closeTo(6000 / 90000, 1e-9);
    });

    it('does not fill gaps larger than maxBufferHole', function () {
      const samples = closedGop();
      // first frame presented 0.2 s after the playlist start
      samples.forEach((sample) => (sample.pts += 12000));
      const result = remuxStart(samples);
      expect(result?.startPTS).to.be.closeTo(18000 / 90000, 1e-9);
    });

    it('keeps the presentation order when a leading picture is presented before the first frame', function () {
      // Open GOP: the B frame decoded after the I frame is presented before it
      const result = remuxStart([
        ptsDts(initTime + 6000, initTime),
        ptsDts(initTime + 3000, initTime + 3000),
        ptsDts(initTime + 15000, initTime + 6000),
        ptsDts(initTime + 9000, initTime + 9000),
      ]);
      expect(result?.startPTS).to.be.closeTo(3000 / 90000, 1e-9);
    });
  });
});

function ptsDts(pts: number, dts: number): VideoSample {
  return {
    dts,
    pts,
    key: true,
    frame: true,
    units: [
      {
        data: new Uint8Array(1),
        type: 0,
      },
    ],
    length: 1,
  };
}
