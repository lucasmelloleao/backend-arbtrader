/*
 * Copyright (c) 2017 Dukascopy (Suisse) SA. All Rights Reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * -Redistribution of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *
 * -Redistribution in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation
 *  and/or other materials provided with the distribution.
 * 
 * Neither the name of Dukascopy (Suisse) SA or the names of contributors may
 * be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * This software is provided "AS IS," without a warranty of any kind. ALL
 * EXPRESS OR IMPLIED CONDITIONS, REPRESENTATIONS AND WARRANTIES, INCLUDING
 * ANY IMPLIED WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
 * OR NON-INFRINGEMENT, ARE HEREBY EXCLUDED. DUKASCOPY (SUISSE) SA ("DUKASCOPY")
 * AND ITS LICENSORS SHALL NOT BE LIABLE FOR ANY DAMAGES SUFFERED BY LICENSEE
 * AS A RESULT OF USING, MODIFYING OR DISTRIBUTING THIS SOFTWARE OR ITS
 * DERIVATIVES. IN NO EVENT WILL DUKASCOPY OR ITS LICENSORS BE LIABLE FOR ANY LOST
 * REVENUE, PROFIT OR DATA, OR FOR DIRECT, INDIRECT, SPECIAL, CONSEQUENTIAL,
 * INCIDENTAL OR PUNITIVE DAMAGES, HOWEVER CAUSED AND REGARDLESS OF THE THEORY
 * OF LIABILITY, ARISING OUT OF THE USE OF OR INABILITY TO USE THIS SOFTWARE,
 * EVEN IF DUKASCOPY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
 */
package singlejartest;

import java.awt.BorderLayout;
import java.awt.Desktop;
import java.awt.Dimension;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Future;

import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.border.EmptyBorder;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.dukascopy.api.IChart;
import com.dukascopy.api.IStrategy;
import com.dukascopy.api.Instrument;
import com.dukascopy.api.LoadingProgressListener;
import com.dukascopy.api.system.ISystemListener;
import com.dukascopy.api.system.ITesterClient;
import com.dukascopy.api.system.TesterFactory;
import com.dukascopy.api.system.tester.ITesterExecution;
import com.dukascopy.api.system.tester.ITesterExecutionControl;
import com.dukascopy.api.system.tester.ITesterGui;
import com.dukascopy.api.system.tester.ITesterUserInterface;

/**
 * This small program demonstrates how to initialize Dukascopy historical tester and start a strategy
 */
public class TesterMain {
    private static final Logger LOGGER = LoggerFactory.getLogger(TesterMain.class);

    private static final String jnlpUrl = "http://platform.dukascopy.com/demo_3/jforex_3.jnlp";
    private static final String userName = "username";
    private static final String password = "password";
    private static final String reportFileName = "report.html";
    private static Path reportPath = null;

    private static ITesterClient client;
    private static ITesterExecutionControl executionControl;
    private static Map<IChart, ITesterGui> chartPanels;
    private static ExecutionControlForm executionControlForm;

    public static void main(String[] args) throws Exception {
        executionControlForm = new ExecutionControlForm(new JFrame());
        executionControlForm.show();
        executionControlForm.setMessage("Initializing, please wait ...");

        reportPath = getReportPath();
        client = TesterFactory.getDefaultInstance();
        setSystemListener();
        tryToConnect();
        subscribeToInstruments();
        client.setInitialDeposit(Instrument.EURUSD.getSecondaryJFCurrency(), 50000);
        loadData();

        executionControlForm.setReadyToTest();
    }

    private static void setSystemListener() {
        client.setSystemListener(new ISystemListener() {
            @Override
            public void onStart(long processId) {
                LOGGER.info("Strategy is started: " + processId);
            }

            @Override
            public void onStop(long processId) {
                LOGGER.info("Strategy is stopped: " + processId);
                File reportFile = reportPath.toFile();
                LOGGER.info("The report is created: " + reportPath.toString());
                try {
                    client.createReport(processId, reportFile);
                    executionControlForm.setFinish(reportFile);
                } catch (Exception e) {
                    LOGGER.error(e.getMessage(), e);
                }

                executionControlForm.setReadyToTest();
            }

            @Override
            public void onConnect() {
                LOGGER.info("Connected");
            }

            @Override
            public void onDisconnect() {
                //tester doesn't disconnect
            }
        });
    }

    private static void tryToConnect() throws Exception {
        LOGGER.info("Connecting...");

        //connect to the server using jnlp, user name and password
        //connection is needed for data downloading
        client.connect(jnlpUrl, userName, password);

        //wait for it to connect
        int i = 10; //wait max ten seconds
        while (i > 0 && !client.isConnected()) {
            Thread.sleep(1000);
            i--;
        }
        if (!client.isConnected()) {
            LOGGER.error("Failed to connect Dukascopy servers");
            System.exit(1);
        }
    }

    private static void subscribeToInstruments() {
        //set instruments that will be used in testing
        Set<Instrument> instruments = new HashSet<>();
        instruments.add(Instrument.EURUSD);
        LOGGER.info("Subscribing instruments...");
        client.setSubscribedInstruments(instruments);
    }

    private static void loadData() throws InterruptedException, java.util.concurrent.ExecutionException {
        //load data
        LOGGER.info("Downloading data");
        Future<?> future = client.downloadData(null);
        //wait for downloading to complete
        future.get();
    }

    private static void startHistoricalTesting(IStrategy strategy) {
        try {
            Files.delete(reportPath);
        } catch (IOException e) {
            LOGGER.error("Cannot delete previous report file: " + e.getMessage());
        }

        ITesterExecution execution = executionControl -> TesterMain.executionControl = executionControl;
        ITesterUserInterface userInterface = chartPanels -> TesterMain.chartPanels = chartPanels;

        client.startStrategy(strategy, getLoadingProgressListener(), execution, userInterface);
    }

    private static void pauseStrategy() {
        executionControl.pauseExecution();
    }

    private static void stopStrategy() {
        executionControl.cancelExecution();
    }

    private static void resumeStrategy() {
        if (executionControl.isExecutionPaused()) {
            executionControl.continueExecution();
        }
    }

    private static Path getReportPath() {
        String reportDirectory = getReportDirectory();
        return Paths.get(reportDirectory, reportFileName);
    }

    private static String getReportDirectory() {
        String tmpDirectory = System.getProperty("java.io.tmpdir");
        if(tmpDirectory != null){
            tmpDirectory = tmpDirectory.trim();
        }

        if(tmpDirectory == null || tmpDirectory.isEmpty()) {
            tmpDirectory = "C:\\";
        }

        return tmpDirectory;
    }

    private static LoadingProgressListener getLoadingProgressListener() {
        return new LoadingProgressListener() {
            @Override
            public void dataLoaded(long startTime, long endTime, long currentTime, String information) {
                LOGGER.info(information);
            }

            @Override
            public void loadingFinished(boolean allDataLoaded, long startTime, long endTime, long currentTime) {
            }

            @Override
            public boolean stopJob() {
                return false;
            }
        };
    }

    private static class ExecutionControlForm {
        private static Dimension BUTTON_SIZE = new Dimension(85, 50);
        private JFrame frame;
        private JPanel contentPane;
        private JLabel messageLabel;

        private boolean isRunning = false;
        private boolean isPaused = false;

        private JButton pauseButton;
        private JButton startButton;
        private JButton stopButton;
        private JButton reportButton;

        private File reportFile;

        private ExecutionControlForm (JFrame frame) {
            this.frame = frame;
            build();
        }

        public void show() {
            frame.setVisible(true);
        }

        public void showFinishDialog() {
            JOptionPane.showMessageDialog(frame, "The test is finished");
        }

        public void setFinish(File reportFile) {
            showFinishDialog();

            isPaused = false;
            isRunning = false;

            startButton.setEnabled(true);
            stopButton.setEnabled(false);
            pauseButton.setEnabled(false);
            reportButton.setEnabled(false);

            //Report processing. First check if Desktop is supported by Platform or not
            this.reportFile = reportFile;
            if(! Desktop.isDesktopSupported()){
                LOGGER.error("Desktop is not supported");
                return;
            }

            try {
                if(reportFile.exists()) {
                    reportButton.setEnabled(true);
                }
            } catch (Exception e) {
                LOGGER.error(e.getMessage(), e);
            }
        }

        private void build() {
            messageLabel = new JLabel(" ");
            contentPane = new JPanel();
            contentPane.setBorder(new EmptyBorder(50, 50, 50, 50));
            contentPane.setLayout(new BorderLayout(5, 5));
            frame.setContentPane(contentPane);

            pauseButton = new JButton(new ImageIcon("resources\\icons\\pause.png"));
            startButton = new JButton(new ImageIcon("resources\\icons\\start.png"));
            stopButton = new JButton(new ImageIcon("resources\\icons\\stop.png"));
            reportButton = new JButton("Open report");


            contentPane.add(messageLabel, BorderLayout.PAGE_START);
            contentPane.add(startButton, BorderLayout.LINE_START);
            contentPane.add(pauseButton, BorderLayout.CENTER);
            contentPane.add(stopButton, BorderLayout.LINE_END);
            contentPane.add(reportButton, BorderLayout.PAGE_END);

            startButton.setPreferredSize(BUTTON_SIZE);
            pauseButton.setPreferredSize(BUTTON_SIZE);
            stopButton.setPreferredSize(BUTTON_SIZE);


            startButton.setEnabled(false);
            stopButton.setEnabled(false);
            pauseButton.setEnabled(false);
            reportButton.setEnabled(false);

            reportButton.addActionListener(e -> {
                Desktop desktop = Desktop.getDesktop();
                try {
                    desktop.open(reportFile);
                } catch (Exception e1) {
                    LOGGER.error(e1.getMessage(), e1);
                }
            });

            startButton.addActionListener(e -> {
                if(!isRunning) {
                    TesterMain.startHistoricalTesting(new MA_Play());
                    isRunning = true;
                }
                else if(isPaused) {
                    TesterMain.resumeStrategy();
                    isPaused = false;
                }
                setMessage("Running");
                startButton.setEnabled(false);
                pauseButton.setEnabled(true);
                stopButton.setEnabled(true);
                reportButton.setEnabled(false);
            });

            pauseButton.addActionListener(e -> {
                if(!isPaused && isRunning) {
                    TesterMain.pauseStrategy();

                    setMessage("Paused");
                    LOGGER.info("Strategy is paused.");
                    isPaused = true;
                    startButton.setEnabled(true);
                    pauseButton.setEnabled(false);
                }
            });

            stopButton.addActionListener(e -> {
                if(isRunning) {
                    TesterMain.stopStrategy();

                    isPaused = false;
                    isRunning = false;
                    startButton.setEnabled(true);
                    stopButton.setEnabled(false);
                    pauseButton.setEnabled(false);

                }
            });

            frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
            frame.setTitle("Execution control of HT");
            frame.setResizable(false);
            frame.setAlwaysOnTop( true );
            frame.pack();
            frame.setLocationRelativeTo(null);
        }

        public void setMessage(String message) {
            messageLabel.setText(message);
        }

        public void setReadyToTest() {
            setMessage("Ready");
            startButton.setEnabled(true);
        }
    }
}
